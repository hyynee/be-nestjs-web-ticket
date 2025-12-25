import { Types } from 'mongoose';

export interface ChatCompletion {
  prompt: string;
  response: string;
  timestamp: Date;
}

export interface ChatResponse {
  response: string;
  eventData: EventData[]; 
  intent: string;
  timestamp: Date;
}

export interface EventData {
  id: Types.ObjectId | string;
  title: string;
  description?: string;
  startDate: Date;
  endDate: Date;
  location: string;
  thumbnail?: string;
  isActiveNow: boolean;
  status: 'draft' | 'active' | 'inactive' | 'ended';
}

export interface FormattedEvent {
  id: string;
  title: string;
  description?: string;
  startDate: string;
  endDate: string;
  location: string;
  thumbnail?: string;
  isActiveNow: boolean;
  status: string;
  duration?: string;
}