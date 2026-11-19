// Types for the parts of noVNC 1.6.0 the console view uses (the package ships none). `@novnc/novnc/lib/*` resolves to the vendored
// copy in vendor/novnc (tsconfig paths, the vitest alias and the plugin build all read that mapping).
declare module "@novnc/novnc/core/rfb.js" {
  export interface RfbOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    repeaterID?: string;
    wsProtocols?: string[];
  }
  export interface RfbEvent<T = unknown> extends Event {
    detail: T;
  }
  export default class RFB extends EventTarget {
    /** `channel` is a WebSocket-shaped object instead of a URL: noVNC attaches to it. */
    constructor(target: HTMLElement, channel: object | string, options?: RfbOptions);
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    readonly capabilities: { power: boolean };
    disconnect(): void;
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(options?: FocusOptions): void;
    blur(): void;
  }
}
