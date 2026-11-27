// The shared worker that carries what an extension page in a tab says to the
// extension's background service worker, and what the worker says back,
// ports and all. The worker runs in the global page, in Safari's own
// process, and a tab's page in a web process of its own: the two share no
// window, but a shared worker of the extension's is the same one for both,
// and its ports carry ports.
//
// The global page connects as the host. Each page connects as a client,
// with an id of its own; the relay tells the host of it, and passes each
// message, with the ports it transfers, between the client and the host.

(function (g) {
  "use strict";

  var host = null;
  var clients = {};
  var waiting = [];

  function toHost(message, ports) {
    if (host) {
      host.postMessage(message, ports || []);
    } else {
      waiting.push([message, ports || []]);
    }
  }

  g.onconnect = function (event) {
    var port = event.ports[0];
    var clientId = null;
    port.onmessage = function (e) {
      var m = e.data || {};
      var ports = Array.prototype.slice.call(e.ports || []);
      if (m.wex === "host") {
        host = port;
        waiting.splice(0).forEach(function (entry) {
          host.postMessage(entry[0], entry[1]);
        });
        Object.keys(clients).forEach(function (id) {
          host.postMessage({ wex: "connect", id: id, url: clients[id].url });
        });
      } else if (m.wex === "client") {
        clientId = String(m.id);
        clients[clientId] = { port: port, url: String(m.url || "") };
        toHost({ wex: "connect", id: clientId, url: clients[clientId].url });
      } else if (m.wex === "post" && port === host) {
        var client = clients[m.id];
        if (client) {
          client.port.postMessage({ wex: "post", data: m.data }, ports);
        }
      } else if (m.wex === "post" && clientId) {
        toHost({ wex: "post", id: clientId, data: m.data }, ports);
      } else if (m.wex === "close" && clientId) {
        delete clients[clientId];
        toHost({ wex: "close", id: clientId });
      }
    };
    port.start();
  };
})(self);
