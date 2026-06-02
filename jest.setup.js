// Allow BigInt values to be serialized in Jest workers and snapshots
Object.defineProperty(BigInt.prototype, 'toJSON', {
  value: function () { return this.toString(); },
  writable: true,
  configurable: true,
});
