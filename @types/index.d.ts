declare module 'chromium' {
  export readonly const path: string;
  export function install(): Promise<void>;
}
