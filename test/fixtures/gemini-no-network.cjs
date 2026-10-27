// Fake CLI only: a missing fixture must not become a paid network request.
const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const path = typeof args[0] === "string" ? args[0] : args[0]?.path;
  if (path?.startsWith("/")) return original.apply(this, args);
  throw new Error("AMUX_FAKE_NETWORK_REFUSED");
};
globalThis.fetch = async () => { throw new Error("AMUX_FAKE_NETWORK_REFUSED"); };
syncBuiltinESMExports();
