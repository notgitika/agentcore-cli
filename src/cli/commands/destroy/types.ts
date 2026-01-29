export interface DestroyOptions {
  target?: string;
  yes?: boolean;
  json?: boolean;
}

export interface DestroyResult {
  success: boolean;
  targetName?: string;
  stackName?: string;
  error?: string;
}
