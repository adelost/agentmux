import { defineWakeWordFeature } from "./wake-word.js";

/** Link's hands-free wake word; phone-only because Wear keeps push-to-talk. */
export const linkWakeWord = defineWakeWordFeature("link");
