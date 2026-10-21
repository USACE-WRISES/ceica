// Bootstrap 5.3.8's modal and tab plugins, imported on their own (the package ships no types).
// Adapted from STAF's static app (src/app/vendor.d.ts).
declare module 'bootstrap/js/dist/modal' {
  export default class Modal {
    constructor(element: Element, options?: Record<string, unknown>)
    static getInstance(element: Element): Modal | null
    static getOrCreateInstance(element: Element): Modal
    show(): void
    hide(): void
    dispose(): void
  }
}

declare module 'bootstrap/js/dist/tab' {
  export default class Tab {
    constructor(element: Element)
    static getOrCreateInstance(element: Element): Tab
    show(): void
    dispose(): void
  }
}
