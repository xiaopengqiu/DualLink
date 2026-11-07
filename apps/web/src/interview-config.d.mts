import type {InterviewConfig,InterviewMode,InterviewPreferences} from './interview-types';
export function modeReady(config:Partial<InterviewConfig>|null|undefined,mode?:InterviewMode):boolean;
export function interviewPreferences(config?:Partial<InterviewConfig>,saved?:Partial<InterviewPreferences>):InterviewPreferences;
