export interface PlanOptions {
  target?: string;
  yes?: boolean;
  json?: boolean;
  deploy?: boolean;
}

export interface PlanResult {
  success: boolean;
  targetName?: string;
  stackNames?: string[];
  stackName?: string;
  message?: string;
  error?: string;
  outputs?: Record<string, string>;
}
