const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const DEFAULT_DEBUG_ENDPOINT = "http://127.0.0.1:9222/json/version";
const WS_ENDPOINT_PATTERN = /ws:\/\/127\.0\.0\.1:9222\/devtools\/browser\/[A-Za-z0-9-]+/;

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function discoverBrowserWsEndpoint() {
  if (process.env.SKYWARD_CHROME_WS_ENDPOINT && process.env.SKYWARD_CHROME_WS_ENDPOINT.trim()) {
    return process.env.SKYWARD_CHROME_WS_ENDPOINT.trim();
  }

  try {
    const response = await fetch(DEFAULT_DEBUG_ENDPOINT);
    if (response.ok) {
      const payload = await response.json();
      if (payload.webSocketDebuggerUrl) {
        return payload.webSocketDebuggerUrl;
      }
    }
  } catch (error) {
    // Fall back to the local Chrome DevTools MCP process.
  }

  try {
    const { stdout } = await execFileAsync("/bin/ps", ["aux"]);
    const endpointMatch = stdout.match(WS_ENDPOINT_PATTERN);
    if (endpointMatch) {
      return endpointMatch[0];
    }
  } catch (error) {
    // Ignore and throw the clearer error below.
  }

  throw new Error(
    "Could not find a Chrome browser websocket endpoint. Set SKYWARD_CHROME_WS_ENDPOINT or start Chrome with remote debugging enabled."
  );
}

class BrowserSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextMessageId = 0;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    if (this.socket) {
      return;
    }

    this.socket = new WebSocket(this.wsUrl);

    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onError);
      };

      this.socket.addEventListener("open", onOpen, { once: true });
      this.socket.addEventListener("error", onError, { once: true });
      this.socket.addEventListener("message", (event) => {
        this.handleMessage(event);
      });
      this.socket.addEventListener("close", () => {
        this.rejectAllPending(new Error("Chrome DevTools websocket closed."));
      });
    });
  }

  handleMessage(event) {
    const message = JSON.parse(event.data.toString());
    if (!message.id) {
      return;
    }

    const pendingRequest = this.pending.get(message.id);
    if (!pendingRequest) {
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pendingRequest.timeoutId);

    if (message.error) {
      pendingRequest.reject(new Error(message.error.message || "Chrome DevTools request failed."));
      return;
    }

    pendingRequest.resolve(message.result);
  }

  rejectAllPending(error) {
    for (const pendingRequest of this.pending.values()) {
      clearTimeout(pendingRequest.timeoutId);
      pendingRequest.reject(error);
    }
    this.pending.clear();
  }

  async send(method, params = {}, sessionId = null, timeoutMs = 15000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome DevTools websocket is not connected.");
    }

    const id = ++this.nextMessageId;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Chrome DevTools response to ${method}.`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeoutId });
      this.socket.send(JSON.stringify(payload));
    });
  }

  async listPageTargets() {
    const result = await this.send("Target.getTargets");
    return result.targetInfos.filter((targetInfo) => targetInfo.type === "page");
  }

  async createPage(url) {
    const result = await this.send("Target.createTarget", { url });
    return result.targetId;
  }

  async attach(targetId) {
    const result = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return new PageSession(this, targetId, result.sessionId);
  }

  async detach(sessionId) {
    await this.send("Target.detachFromTarget", { sessionId });
  }

  async close() {
    if (!this.socket) {
      return;
    }

    this.rejectAllPending(new Error("Chrome DevTools websocket closed."));
    this.socket.close();
    this.socket = null;
  }
}

class PageSession {
  constructor(browserSession, targetId, sessionId) {
    this.browserSession = browserSession;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  async enable() {
    await this.browserSession.send("Runtime.enable", {}, this.sessionId);
    await this.browserSession.send("Page.enable", {}, this.sessionId);
  }

  async evaluate(expression, timeoutMs = 15000) {
    const result = await this.browserSession.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true
      },
      this.sessionId,
      timeoutMs
    );

    if (result.exceptionDetails) {
      const description =
        result.result && result.result.description
          ? result.result.description
          : result.exceptionDetails.text || "Unknown page evaluation error.";
      throw new Error(description);
    }

    return result.result ? result.result.value : undefined;
  }

  async navigate(url) {
    await this.browserSession.send("Page.navigate", { url }, this.sessionId);
  }

  async waitFor(predicateExpression, timeoutMs = 15000, intervalMs = 250) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const isReady = await this.evaluate(predicateExpression, timeoutMs);
      if (isReady) {
        return;
      }
      await delay(intervalMs);
    }

    throw new Error("Timed out waiting for the Skyward page to finish loading.");
  }

  async close() {
    await this.browserSession.detach(this.sessionId);
  }
}

async function openBrowserSession() {
  const wsUrl = await discoverBrowserWsEndpoint();
  const browserSession = new BrowserSession(wsUrl);
  await browserSession.connect();
  return browserSession;
}

module.exports = {
  discoverBrowserWsEndpoint,
  openBrowserSession
};
