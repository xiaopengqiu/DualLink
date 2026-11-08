interface ScreenshotDraft {ids:string[];sizes:Record<string,number>;request:{signature:string;requestId:string}|null;}
export function readScreenshotDraft(storage:Pick<Storage,'getItem'>,account:string|null|undefined):ScreenshotDraft;
export function writeScreenshotDraft(storage:Pick<Storage,'setItem'>,account:string|null|undefined,draft:ScreenshotDraft):void;
