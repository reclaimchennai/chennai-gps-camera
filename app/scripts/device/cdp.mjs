/**
 * Minimal Chrome DevTools Protocol client for the app's WebView on a
 * phone or emulator (adb forward tcp:PORT localabstract:webview_devtools_remote_<pid>).
 * Playwright's connectOverCDP does not work with Android WebView.
 */
export async function connect(port = Number(process.env.CDP_PORT || 9333)) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find((p) => p.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) =>
    new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  /** evaluate an async function body in the page, return its value */
  const evaluate = async (body) => {
    const res = await send("Runtime.evaluate", {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 800));
    return res.result?.result?.value;
  };
  /** a real touch (pointer capture and touch-only paths behave as on a finger) */
  const tap = async (x, y, holdMs = 60) => {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await new Promise((r) => setTimeout(r, holdMs));
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  return { send, evaluate, tap, close: () => ws.close() };
}
