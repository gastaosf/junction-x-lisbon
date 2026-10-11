// SharedWorker: the one EventSource on /api/stream that every tab of this browser shares.
// All the logic is in logic/relay.js; this file only connects it to the worker's ports. store.js
// starts it, and falls back to an EventSource of its own where shared workers are not available.

import { createRelay } from "./logic/relay.js";

const STREAM_URL = "/api/stream";
const FRAMES = ["snapshot", "msg", "ping"];

const relay = createRelay({
  openSource({ onFrame, onError }) {
    const source = new EventSource(STREAM_URL);
    for (const kind of FRAMES) source.addEventListener(kind, (event) => onFrame(kind, event.data));
    // We reconnect ourselves (the relay backs off and tells the tabs), so close on any error.
    source.onerror = () => onError();
    return {
      close() {
        source.onerror = null;
        source.close();
      },
    };
  },
});

self.onconnect = (event) => {
  const port = event.ports[0];
  port.onmessage = (message) => relay.receive(port, message.data);
  port.start();
};
