/// <reference types="svelte" />
declare module "*.svelte" {
  import { SvelteComponentTyped } from "svelte";
  export default class _SvelteComponent extends SvelteComponentTyped<any, any, any> {}
  export function render(...args: any[]): any;
}

interface WebOSTVjsGlobal {
  platform: any;
  session: any;
  common: any;
  toast: any;
  launchParams: any;
  appData: any;
}

declare const webOSTVjs: WebOSTVjsGlobal;

interface LunaService {
  subscribe: (
    service: string,
    method: string,
    callback: (result: any, cbId: number) => void,
    params?: any
  ) => number;
  unsubscribe: (subscriptionId: number) => boolean;
  unsubscribeAll: () => void;
}
interface LunaAppGlobal {
  luna: { service: LunaService; app: any };
}
declare const luna: LunaAppGlobal;

interface WebOSHTMLVideoElement extends HTMLVideoElement {
  // webOS extensions (present ≥3.0 in webview / native)
  audioTracks?: {
    length: number;
    item: (i: number) => any;
    [index: number]: any;
    addEventListener: (type: string, cb: (e: any) => void) => void;
  };
  textTracks?: any;
}
