# AZQueue Library

This library partially implements the Azure Queue API, using Postgres.  It
implements enough of the API to support the use of Azure Queues by the
Taskcluster Queue service.  Tehavior of the API conforms to the [Azure
Documentatation](https://docs.microsoft.com/en-us/rest/api/storageservices/queue-service-rest-api).
The details of the API conform to those of the
[fast-azure-storage](https://taskcluster.github.io/fast-azure-storage/classes/Queue.html)
library.  Like [taskcluster-lib-entities](../entities), this library is a
temporary shim to assist with migration to a native Postgres backend.

## Usage

```javascript
const AZQueue = require('taskclsuter-lib-azqueue');

const db = await Database.setup(...);
const azqueue = new AZQueue({ db });

// there's no need to create or delete queues, so these are all no-ops
await azqueue.createQueue(queueName); // no-op
await azqueue.deleteQueue(queueName); // no-op
await azqueue.listQueues();  // (returns an emtpy list of queues)

// queue metadata is not tracked
await azqueue.setMetadata(queueName, metadata); // no-op
const  { messageCount } = await azqueue.getMetadata(queueName); // only returns count

// put a message in a queue
await azqueue.putMessage(
    queueName,
    messageText, // utf8 string
    {
        visibilityTimeout: 10, // in seconds
        messageTTL: 100, // in seconds
    });

// get messages from a queue.  If there are no messages, this immediately returns an
// empty list.  Poll this function (gently!).
const messages = await azqueue.getMessages(
    queueName,
    {
        visibilityTimeout: 10, // in seconds
        numberOfMessages: 1,
    });
// -> [{messageText, messageId, popReceipt}, ..]

// delete a message from a queue
await azqueue.getMessages(
    queueName,
    messageId,
    popReceipt);

// Delete all expired messages in all queues.  This is a maintenance task that
// should run about once an hour on a busy system.
await azqueue.deleteExpiredMessages();
```

## Using this in Queue service

* Add the db version file in this library's tests to the monorepo's db versions
* Remove queue-deletion logic (including from `procs.yml`)
* Add a new hourly crontask to call `deleteExpiredMessages`