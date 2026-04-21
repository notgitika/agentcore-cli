export interface TracesListOptions {
  runtime?: string;
  harness?: string;
  limit?: string;
  since?: string;
  until?: string;
}

export interface TracesGetOptions {
  runtime?: string;
  harness?: string;
  output?: string;
  since?: string;
  until?: string;
}
