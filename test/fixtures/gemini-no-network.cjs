// Only for the isolated fake-CLI journey. A missing fake cannot become a paid call.
const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const path = typeof first === "string" ? first : first?.path;
  if (path?.startsWith("/")) return originalConnect.apply(this, args);
  throw new Error("AMUX_FAKE_NETWORK_REFUSED");
};
globalThis.fetch = async () => { throw new Error("AMUX_FAKE_NETWORK_REFUSED"); };
syncBuiltinESMExports();
