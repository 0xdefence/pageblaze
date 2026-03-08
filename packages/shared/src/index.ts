export type JobType = "scrape" | "crawl";
export type JobStatus = "queued" | "running" | "done" | "failed";
export const QUEUE_NAME = "pageblaze-jobs";
export const ALERT_QUEUE_NAME = "pageblaze-alerts";
export * from './db';
export * from './url';
export * from './robots';
