import type { SymphonyApi } from "../shared/types.js";

declare global {
  interface Window {
    symphony: SymphonyApi;
  }
}

export {};

