import { eventQueue } from "./queue.js";
import { sendEvents } from "./sender.js";
const BATCH_SIZE = 50;
const FLUSH_INTERVAL = 5000; // 5 sec
let interval = null;
export function startBatcher() {
    if (interval)
        return;
    interval = setInterval(async () => {
        try {
            if (eventQueue.size() === 0)
                return;
            const events = eventQueue.drain(BATCH_SIZE);
            await sendEvents(events);
        }
        catch (err) {
            console.error("[SDK] batch send failed");
        }
    }, FLUSH_INTERVAL);
}
