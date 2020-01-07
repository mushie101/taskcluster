const assert = require('assert').strict;

class RowClass {
  constructor(properties, options = {}) {
    const {
      etag,
      tableName,
      documentId,
      db,
    } = options;

    this.properties = properties;
    this.etag = etag;
    this.tableName = tableName;
    this.documentId = documentId;
    this.db = db;
  }

  remove() {
    return this.db.procs[`${this.tableName}_remove`](this.documentId);
  }

  // load the properties from the table once more, and return true if anything has changed.
  // Else, return false.
  async reload() {
    const result = await this.db.procs[`${this.tableName}_load`](this.documentId);
    const etag = result[0].etag;

    return etag !== this.etag;
  }

  async modify(modifier) {}
}

module.exports = RowClass;