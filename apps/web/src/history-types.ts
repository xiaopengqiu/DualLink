import type {Capture,Task} from './types';
import type {Interview} from './interview-types';
export type HistoryKind='captures'|'interviews';
export interface HistorySettings {retentionDays:number;maxCaptures:number;maxInterviews:number;maxStorageMiB:number;autoCleanup:boolean;}
export interface HistoryUsage {captures:number;interviews:number;tasks:number;captureBytes:number;audioBytes:number;totalBytes:number;protectedCaptures:number;protectedInterviews:number;pendingFileDeletes?:number;pendingFileBytes?:number;}
export interface CaptureHistoryItem extends Capture {size:number;latestTask?:Task|null;protected:boolean;protectedReason?:string|null;}
export interface InterviewHistoryItem extends Interview {audioBytes:number;protected:boolean;protectedReason?:string|null;}
export interface HistoryOverview {settings:HistorySettings;usage:HistoryUsage;rawAudioRetentionDays?:number;}
export interface HistoryPage {items:(CaptureHistoryItem|InterviewHistoryItem)[];total:number;nextCursor:string|null;hasMore:boolean;}
export interface HistoryDeleteResult {deletedIds:string[];deletedTaskIds:string[];skippedIds:string[];deletedCount:number;usage?:HistoryUsage;}
export interface HistoryEvent {type:'history.deleted'|'history.updated';kind?:HistoryKind;deletedIds?:string[];deletedTaskIds?:string[];reason?:'manual'|'auto';settings?:HistorySettings;usage?:HistoryUsage;}
