let assert = require('assert');
let data = require('./data');
let QueueService = require('./queueservice');
let Iterate = require('taskcluster-lib-iterate');

/**
 * Facade that handles resolution of claims by takenUntil, using the advisory
 * messages from the azure queue. The azure queue messages takes the form:
 * `{taskId, runId, takenUntil}`, and they become visible after `takenUntil`
 * has been exceeded. The messages advice that if a task with the given
 * `takenUntil` and `taskId` exists, then `runId` maybe need to be resolved by
 * `claim-expired` and the task retried (depending on `retriesLeft`).
 *
 * Notice, that the task may not exists, or may not have a the given run, or
 * it may be the case that the `takenUntil` doesn't match. These should be
 * ignored as it implies a failed request (which wasn't retried) or a run
 * that was reclaimed.
 */
class ClaimResolver {
  /**
   * Create ClaimResolver instance.
   *
   * options:
   * {
   *   Task:              // instance of data.Task
   *   queueService:      // instance of QueueService
   *   dependencyTracker: // instance of DependencyTracker
   *   publisher:         // publisher from base.Exchanges
   *   pollingDelay:      // Number of ms to sleep between polling
   *   parallelism:       // Number of polling loops to run in parallel
   *                      // Each handles up to 32 messages in parallel
   *   monitor:           // base.monitor instance
   * }
   */
  constructor(options) {
    assert(options, 'options must be given');
    assert(options.Task.prototype instanceof data.Task,
      'Expected data.Task instance');
    assert(options.queueService instanceof QueueService,
      'Expected instance of QueueService');
    assert(options.dependencyTracker, 'Expected a DependencyTracker instance');
    assert(options.publisher, 'Expected a publisher');
    assert(typeof options.pollingDelay === 'number',
      'Expected pollingDelay to be a number');
    assert(typeof options.parallelism === 'number',
      'Expected parallelism to be a number');
    assert(options.monitor !== null, 'options.monitor required!');
    this.Task = options.Task;
    this.queueService = options.queueService;
    this.dependencyTracker = options.dependencyTracker;
    this.publisher = options.publisher;
    this.pollingDelay = options.pollingDelay;
    this.parallelism = options.parallelism;
    this.monitor = options.monitor;

    this.iterator = new Iterate({
      name: 'ClaimResolver',
      maxFailures: 10,
      waitTime: this.pollingDelay,
      monitor: this.monitor,
      maxIterationTime: 600 * 1000,
      handler: async () => {
        let loops = [];
        for (let i = 0; i < this.parallelism; i++) {
          loops.push(this.poll());
        }
        await Promise.all(loops);
      },
    });

    this.iterator.on('error', () => {
      this.monitor.alert('iteration failed repeatedly; terminating process');
      process.exit(1);
    });
  }

  /** Start polling */
  async start() {
    return this.iterator.start();
  }

  /** Terminate iteration, returns promise that polling is stopped */
  terminate() {
    return this.iterator.stop();
  }

  /** Poll for messages and handle them in a loop */
  async poll() {
    let messages = await this.queueService.pollClaimQueue();
    let failed = 0;

    await Promise.all(messages.map(async (message) => {
      // Don't let a single task error break the loop, it'll be retried later
      // as we don't remove message unless they are handled
      try {
        await this.handleMessage(message);
      } catch (err) {
        failed += 1;
        this.monitor.reportError(err, 'warning');
      }
    }));

    this.monitor.log.azureQueuePoll({
      messages: messages.length,
      failed,
      resolver: 'claim',
    });
  }

  /** Sleep for `delay` ms, returns a promise */
  sleep(delay) {
    return new Promise(accept => setTimeout(accept, delay));
  }

  /** Handle advisory message about claim expiration */
  async handleMessage({taskId, runId, takenUntil, remove}) {
    // Query for entity for which we have exact rowKey too, limit to 1, and
    // require that takenUntil matches. This is essentially a conditional load
    // operation. Note, that this possible because we set takenUntil both in
    // the task.runs[runId].takenUntil property and in the task.takenUntil
    // property whenever a task is claimed, reclaimed. And task.takenUntil is
    // cleared whenever a run is resolved, so this conditional load should
    // significantly reduce the amount of task entities that we load.
    let {entries: [task]} = await this.Task.query({
      taskId: taskId, // Matches an exact entity
      takenUntil: takenUntil, // Load conditionally
    }, {
      matchRow: 'exact', // Validate that we match row key exactly
      limit: 1, // Load at most one entity, no need to search
    });

    // If the task doesn't exist, we're done
    if (!task) {
      // don't log this as it's fairly common...
      return remove();
    }

    // Check if this is the takenUntil we're supposed to be resolving for, if
    // this check fails, then the conditional load must have failed so we should
    // report an error
    if (task.takenUntil.getTime() !== takenUntil.getTime()) {
      let err = new Error('Task takenUntil does not match takenUntil from ' +
                          'message, taskId: ' + taskId + ' this only happens ' +
                          'if conditional load does not work');
      err.taskId = taskId;
      err.taskTakenUntil = task.takenUntil.toJSON();
      err.messageTakenUntil = takenUntil.toJSON();
      await this.monitor.reportError(err);
      return remove();
    }

    // Ensure that all runs are resolved
    await task.modify((task) => {
      let run = task.runs[runId];
      if (!run) {
        // The run might not have been created, if the claimTask operation
        // failed
        return;
      }

      // If the run isn't running, or takenUntil has been updated, then we're
      // done. Notice that unlike condition above, we're racing in the
      // task.modify modifier so reloads can happen if there is concurrency!
      // Hence, takenUntil being update is both valid and plausible.
      if (run.state !== 'running' ||
          new Date(run.takenUntil).getTime() !== takenUntil.getTime()) {
        return;
      }

      // If task deadline is exceeded we don't just have claim-expired we, have
      // deadline, expired... And we choose to forget about claim-expired
      if (task.deadline.getTime() <= Date.now()) {
        return;
      }

      // Update run
      run.state = 'exception';
      run.reasonResolved = 'claim-expired';
      run.resolved = new Date().toJSON();

      // Do **NOT** clear takenUntil on task, as this will prevent the message
      // from running again. In case something below fails.

      // If the run isn't the last run, then something is very wrong
      if (task.runs.length - 1 !== runId) {
        let err = new Error('Running runId: ' + runId + ' resolved exception,' +
                            'but it was not the last run! taskId: ' + taskId);
        err.taskId = taskId;
        err.runId = runId;
        this.monitor.reportError(err);
        return;
      }

      // Add retry, if we have retries left
      if (task.retriesLeft > 0) {
        task.retriesLeft -= 1;
        task.runs.push({
          state: 'pending',
          reasonCreated: 'retry',
          scheduled: new Date().toJSON(),
        });
      }
    });

    // Find the run that we (may) have modified
    let run = task.runs[runId];

    // If run isn't resolved to exception with 'claim-expired', we had
    // concurrency and we're done.
    if (!run ||
        task.runs.length - 1 > runId + 1 ||
        run.state !== 'exception' ||
        run.reasonResolved !== 'claim-expired') {
      return remove();
    }

    let status = task.status();

    // If a newRun was created and it is a retry with state pending then we
    // better publish messages about it
    let newRun = task.runs[runId + 1];
    if (newRun &&
        task.runs.length - 1 === runId + 1 &&
        newRun.state === 'pending' &&
        newRun.reasonCreated === 'retry') {
      await Promise.all([
        this.queueService.putPendingMessage(task, runId + 1),
        this.publisher.taskPending({
          status: status,
          runId: runId + 1,
        }, task.routes),
      ]);
      this.monitor.log.taskPending({taskId, runId: runId + 1});
    } else {
      // Update dependencyTracker
      await this.dependencyTracker.resolveTask(taskId, task.taskGroupId, task.schedulerId, 'exception');

      // Publish message about task exception
      await this.publisher.taskException({
        status: status,
        runId: runId,
        workerGroup: run.workerGroup,
        workerId: run.workerId,
      }, task.routes);
      this.monitor.log.taskException({taskId, runId});
    }

    return remove();
  }
}

// Export ClaimResolver
module.exports = ClaimResolver;
