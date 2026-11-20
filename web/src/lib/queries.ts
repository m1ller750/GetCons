import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from './api';
import type {
  ActivityEvent,
  AgentAction,
  AgentOverview,
  BotRequest,
  Analytics,
  BillingOverview,
  Consultant,
  ConsultantDetails,
  Conversation,
  Gap,
  KnowledgeDocument,
  Me,
  Message,
  Template,
  TelegramStatus,
  TrainingExample,
  WhatsAppView,
} from './types';

export const keys = {
  me: ['me'] as const,
  consultants: ['consultants'] as const,
  consultant: (id: string) => ['consultant', id] as const,
  analytics: (id: string, days: number) => ['analytics', id, days] as const,
  gaps: (id: string) => ['gaps', id] as const,
  activity: (id: string) => ['activity', id] as const,
  conversations: (id: string) => ['conversations', id] as const,
  conversation: (id: string, convId: string) => ['conversation', id, convId] as const,
  documents: (id: string) => ['documents', id] as const,
  examples: (id: string) => ['examples', id] as const,
  playground: (id: string) => ['playground', id] as const,
  telegram: (id: string) => ['telegram', id] as const,
  whatsapp: (id: string) => ['whatsapp', id] as const,
  agent: (id: string) => ['agent', id] as const,
  agentActions: (id: string) => ['agent-actions', id] as const,
};

export const useAgent = (id: string) =>
  useQuery({ queryKey: keys.agent(id), queryFn: () => api<AgentOverview>(`/consultants/${id}/agent`), enabled: Boolean(id) });

export const useAgentActions = (id: string, enabled = true) =>
  useQuery({
    queryKey: keys.agentActions(id),
    queryFn: () => api<{ actions: AgentAction[] }>(`/consultants/${id}/agent/actions?limit=100`).then((r) => r.actions),
    enabled: Boolean(id) && enabled,
    refetchInterval: 20_000,
  });

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api<Me>('/me'), staleTime: 5 * 60_000 });

export const useBilling = (poll = false) =>
  useQuery({ queryKey: ['billing'], queryFn: () => api<BillingOverview>('/billing'), refetchInterval: poll ? 3_000 : false });

export const useTemplates = () =>
  useQuery({ queryKey: ['templates'], queryFn: () => api<{ templates: Template[] }>('/consultants/templates'), staleTime: Infinity });

export const useConsultants = () =>
  useQuery({ queryKey: keys.consultants, queryFn: () => api<{ consultants: Consultant[] }>('/consultants').then((r) => r.consultants) });

export const useConsultant = (id: string) =>
  useQuery({ queryKey: keys.consultant(id), queryFn: () => api<ConsultantDetails>(`/consultants/${id}`), enabled: Boolean(id) });

export const useAnalytics = (id: string, days: number) =>
  useQuery({
    queryKey: keys.analytics(id, days),
    queryFn: () =>
      api<Analytics>(`/consultants/${id}/analytics?days=${days}&chartDays=${Math.min(days, 30)}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`),
    refetchInterval: 30_000,
  });

export const useGaps = (id: string) =>
  useQuery({ queryKey: keys.gaps(id), queryFn: () => api<{ gaps: Gap[] }>(`/consultants/${id}/analytics/gaps?limit=8`).then((r) => r.gaps), refetchInterval: 30_000 });

export const useActivity = (id: string) =>
  useQuery({ queryKey: keys.activity(id), queryFn: () => api<{ events: ActivityEvent[] }>(`/consultants/${id}/activity?limit=12`).then((r) => r.events), refetchInterval: 30_000 });

export const useConversations = (id: string, filter: string, q: string, page: number) =>
  useQuery({
    queryKey: [...keys.conversations(id), filter, q, page],
    queryFn: () =>
      api<{ conversations: Conversation[]; total: number; pageSize: number }>(
        `/consultants/${id}/conversations?filter=${filter}&page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    refetchInterval: 8_000,
    placeholderData: (prev) => prev,
  });

export const useConversation = (id: string, convId: string | null) =>
  useQuery({
    queryKey: keys.conversation(id, convId ?? ''),
    queryFn: () => api<{ conversation: Conversation; messages: Message[]; hasMore: boolean }>(`/consultants/${id}/conversations/${convId}?limit=100`),
    enabled: Boolean(convId),
    refetchInterval: 4_000,
  });

export const useDocuments = (id: string) =>
  useQuery({
    queryKey: keys.documents(id),
    queryFn: () => api<{ documents: KnowledgeDocument[] }>(`/consultants/${id}/knowledge`).then((r) => r.documents),
    refetchInterval: (query) => (query.state.data?.some((d) => d.status === 'processing') ? 2_000 : false),
  });

export const useExamples = (id: string, q: string, page: number) =>
  useQuery({
    queryKey: [...keys.examples(id), q, page],
    queryFn: () =>
      api<{ examples: TrainingExample[]; total: number; pageSize: number }>(`/consultants/${id}/examples?page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    placeholderData: (prev) => prev,
  });

export const usePlayground = (id: string) =>
  useQuery({ queryKey: keys.playground(id), queryFn: () => api<{ messages: Message[] }>(`/consultants/${id}/playground`).then((r) => r.messages) });

export const useBotRequest = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: ['botRequest', id],
    queryFn: () => api<{ request: BotRequest | null }>(`/consultants/${id}/telegram/create-bot`).then((r) => r.request),
    enabled,
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 2_500 : false),
  });

export const useTelegramStatus = (id: string, enabled: boolean) =>
  useQuery({ queryKey: keys.telegram(id), queryFn: () => api<TelegramStatus>(`/consultants/${id}/telegram`), enabled, refetchInterval: 15_000 });

/** WhatsApp linking state: polled quickly while a QR code / pairing code is on screen. */
export const useWhatsApp = (id: string) =>
  useQuery({
    queryKey: keys.whatsapp(id),
    queryFn: () => api<{ whatsapp: WhatsAppView }>(`/consultants/${id}/whatsapp`).then((r) => r.whatsapp),
    refetchInterval: (query) => (['pairing', 'connecting'].includes(query.state.data?.status ?? '') ? 2_000 : 20_000),
  });

/** Invalidates everything that depends on one consultant. */
export function useInvalidateConsultant() {
  const qc = useQueryClient();
  return useCallback(
    (id: string) => {
      void qc.invalidateQueries({ queryKey: keys.consultants });
      void qc.invalidateQueries({ queryKey: keys.consultant(id) });
    },
    [qc],
  );
}
