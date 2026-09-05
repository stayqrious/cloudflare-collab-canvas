import { expect, type Page, test } from "@playwright/test";
import { canvasPoint, createBoard, drawShape, waitForBoard } from "./helpers";

type StoredCommand = {
  commandId: string;
  boardId: string;
  command: { commandId: string };
};

async function installAuthoritativeAckControl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWebSocket = globalThis.WebSocket;
    const storageKey = "playwright-hold-authoritative-acks";
    let hold = false;
    try {
      hold = sessionStorage.getItem(storageKey) === "1";
    } catch {
      // The first about:blank document may not expose session storage.
    }
    let releasing = false;
    const held: Array<{ socket: WebSocket; data: unknown }> = [];

    class AckControlledWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols: string | string[] = []) {
        super(url, protocols);
        super.addEventListener("message", (event) => {
          if (!hold || releasing || typeof event.data !== "string") return;
          try {
            const frame = JSON.parse(event.data) as { t?: unknown };
            if (frame.t !== "server.action") return;
            held.push({ socket: this, data: event.data });
            event.stopImmediatePropagation();
          } catch {
            // Invalid JSON must continue to the application protocol handler.
          }
        });
      }
    }

    const setStoredHold = (value: boolean): void => {
      try {
        sessionStorage.setItem(storageKey, value ? "1" : "0");
      } catch {
        // The control still applies to the current document.
      }
    };

    Object.defineProperties(globalThis, {
      WebSocket: { configurable: true, value: AckControlledWebSocket },
      __testAckControl: {
        configurable: true,
        value: {
          hold: () => {
            hold = true;
            setStoredHold(true);
          },
          heldCount: () => held.length,
          release: () => {
            hold = false;
            setStoredHold(false);
            const queued = held.splice(0);
            releasing = true;
            try {
              for (const entry of queued) {
                entry.socket.dispatchEvent(new MessageEvent("message", { data: entry.data }));
              }
            } finally {
              releasing = false;
            }
          },
        },
      },
    });
  });
}

async function setAckHold(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = (
      globalThis as typeof globalThis & {
        __testAckControl?: { hold: () => void };
      }
    ).__testAckControl;
    if (!control) throw new Error("The ACK control is unavailable.");
    control.hold();
  });
}

async function heldAckCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const control = (
      globalThis as typeof globalThis & {
        __testAckControl?: { heldCount: () => number };
      }
    ).__testAckControl;
    if (!control) throw new Error("The ACK control is unavailable.");
    return control.heldCount();
  });
}

async function releaseAcks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = (
      globalThis as typeof globalThis & {
        __testAckControl?: { release: () => void };
      }
    ).__testAckControl;
    if (!control) throw new Error("The ACK control is unavailable.");
    control.release();
  });
}

async function outboxCommands(page: Page, boardId: string): Promise<StoredCommand[]> {
  return page.evaluate(async (requestedBoardId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("cf-collab-canvas");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open the outbox."));
    });
    try {
      const transaction = database.transaction("outbox-v2", "readonly");
      const request = transaction
        .objectStore("outbox-v2")
        .index("boardId")
        .getAll(requestedBoardId);
      return await new Promise<StoredCommand[]>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result as StoredCommand[]);
        request.onerror = () => reject(request.error ?? new Error("Could not read the outbox."));
      });
    } finally {
      database.close();
    }
  }, boardId);
}

test("Saved waits for the authoritative ACK and a refreshed outbox command retries once", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Durability acceptance runs in Chromium.");

  const sentCommandIds: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const frame = JSON.parse(payload) as { t?: unknown; commandId?: unknown };
        if (frame.t === "client.commit" && typeof frame.commandId === "string") {
          sentCommandIds.push(frame.commandId);
        }
      } catch {
        // Application protocol assertions cover malformed frames.
      }
    });
  });

  await installAuthoritativeAckControl(page);
  const boardUrl = await createBoard(page, "Durable acknowledgement");
  const boardId = new URL(boardUrl).pathname.split("/").pop();
  expect(boardId).toBeTruthy();
  await setAckHold(page);

  const start = await canvasPoint(page, 0.3, 0.35);
  await drawShape(
    page,
    "Rectangle",
    start,
    { x: start.x + 95, y: start.y + 60 },
    { waitForSaved: false },
  );
  await expect.poll(() => heldAckCount(page)).toBe(1);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saving");
  await expect(page.getByTestId("save-status")).toContainText("Saving");

  const initialOutbox = await outboxCommands(page, boardId as string);
  expect(initialOutbox).toHaveLength(1);
  const commandId = initialOutbox[0]?.commandId;
  expect(commandId).toBeTruthy();
  expect(initialOutbox[0]?.command.commandId).toBe(commandId);
  await expect.poll(() => sentCommandIds.filter((value) => value === commandId).length).toBe(1);

  await page.reload();
  await expect(page.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(1);
  await expect.poll(() => heldAckCount(page)).toBe(1);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saving");
  await expect.poll(() => sentCommandIds.filter((value) => value === commandId).length).toBe(2);
  const refreshedOutbox = await outboxCommands(page, boardId as string);
  expect(refreshedOutbox.map((entry) => entry.commandId)).toEqual([commandId]);

  await releaseAcks(page);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect.poll(async () => (await outboxCommands(page, boardId as string)).length).toBe(0);

  await page.reload();
  await waitForBoard(page);
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(1);
  expect(sentCommandIds.filter((value) => value === commandId)).toHaveLength(2);
  expect(await outboxCommands(page, boardId as string)).toEqual([]);
});
