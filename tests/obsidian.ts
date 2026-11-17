export const Platform = { isAndroidApp: true };
export class TFile {}
export const requestUrl = (options: unknown) => (globalThis as any).requestUrlMock(options);
