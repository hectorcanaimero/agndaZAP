'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { fetcher } from '@/lib/auth';
import { cn } from '@/lib/utils';

type ConvState = 'BOT' | 'NEEDS_HUMAN' | 'HUMAN';

export interface ConversationListItem {
  id: string;
  chatId: string;
  phone: string;
  state: ConvState;
  updatedAt: string;
  createdAt: string;
  messageCount: number;
  lastMessage: {
    id: string;
    direction: 'IN' | 'OUT';
    body: string;
    createdAt: string;
  } | null;
}

interface Message {
  id: string;
  direction: 'IN' | 'OUT';
  body: string;
  createdAt: string;
}

interface ConversationDetail extends ConversationListItem {
  messages: Message[];
}

interface Props {
  locale: string;
  initialState: string;
  initialConversations: ConversationListItem[];
}

const POLL_INTERVAL_MS = 15000;

/**
 * Sanitiza defensa-en-profundidad el reply antes de mandarlo. El backend
 * también sanitiza (control chars + trim + XSS defense), pero recortamos acá
 * también — no confiar solamente en un lado.
 */
function sanitizeReply(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').trim();
}

/**
 * Bandeja del panel. Layout: sidebar de conversaciones a la izquierda, panel de
 * detalle a la derecha. Polling cada 15s (WebSocket queda para post-MVP).
 */
export function ConversationsClient({
  locale,
  initialState,
  initialConversations,
}: Props) {
  const t = useTranslations('panel.conversations');
  const toast = useToast();

  const [stateFilter, setStateFilter] = useState<string>(initialState);
  const [convos, setConvos] = useState<ConversationListItem[]>(
    initialConversations,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);

  const refetchList = useCallback(async () => {
    const qs = new URLSearchParams();
    // "inbox" = NEEDS_HUMAN + HUMAN. Hacemos 2 requests y mergeamos.
    if (stateFilter === 'inbox') {
      const [a, b] = await Promise.all([
        fetcher<ConversationListItem[]>(
          `/api/conversations?state=NEEDS_HUMAN`,
        ),
        fetcher<ConversationListItem[]>(`/api/conversations?state=HUMAN`),
      ]);
      const merged: ConversationListItem[] = [];
      if (a.ok) merged.push(...a.data);
      if (b.ok) merged.push(...b.data);
      merged.sort(
        (x, y) =>
          new Date(y.updatedAt).getTime() - new Date(x.updatedAt).getTime(),
      );
      setConvos(merged);
      return;
    }
    if (stateFilter === 'all') {
      const res = await fetcher<ConversationListItem[]>(`/api/conversations`);
      if (res.ok) setConvos(res.data);
      return;
    }
    if (stateFilter === 'BOT') qs.set('state', 'BOT');
    if (stateFilter === 'NEEDS_HUMAN') qs.set('state', 'NEEDS_HUMAN');
    if (stateFilter === 'HUMAN') qs.set('state', 'HUMAN');
    const res = await fetcher<ConversationListItem[]>(
      `/api/conversations?${qs.toString()}`,
    );
    if (res.ok) setConvos(res.data);
  }, [stateFilter]);

  // Re-fetch cuando cambia el filtro.
  useEffect(() => {
    void refetchList();
  }, [refetchList]);

  // Polling.
  const pollTimer = useRef<number | null>(null);
  useEffect(() => {
    pollTimer.current = window.setInterval(() => {
      void refetchList();
      if (selectedId) void loadDetail(selectedId, /*silent*/ true);
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetchList, selectedId]);

  async function loadDetail(id: string, silent = false) {
    if (!silent) setDetailLoading(true);
    const res = await fetcher<ConversationDetail>(
      `/api/conversations/${id}?limit=50`,
    );
    if (res.ok) setDetail(res.data);
    if (!silent) setDetailLoading(false);
  }

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId]);

  async function takeOver() {
    if (!detail) return;
    const res = await fetcher(`/api/conversations/${detail.id}/takeover`, {
      method: 'POST',
    });
    if (res.ok) {
      toast.push(t('takeoverOk'), 'success');
      await refetchList();
      await loadDetail(detail.id);
    } else {
      toast.push(t('takeoverFailed'), 'error');
    }
  }

  async function release() {
    if (!detail) return;
    const res = await fetcher(`/api/conversations/${detail.id}/release`, {
      method: 'POST',
    });
    if (res.ok) {
      toast.push(t('releaseOk'), 'success');
      await refetchList();
      await loadDetail(detail.id);
    } else {
      toast.push(t('releaseFailed'), 'error');
    }
  }

  async function sendReply() {
    if (!detail) return;
    const text = sanitizeReply(reply);
    if (!text) {
      toast.push(t('replyEmpty'), 'error');
      return;
    }
    setReplying(true);
    // Optimistic UI: pintamos el mensaje ya. Si falla, lo removemos.
    const tempId = `tmp-${Date.now()}`;
    const optimistic: Message = {
      id: tempId,
      direction: 'OUT',
      body: text,
      createdAt: new Date().toISOString(),
    };
    setDetail((d) =>
      d ? { ...d, messages: [...d.messages, optimistic] } : d,
    );
    const prevText = reply;
    setReply('');

    const res = await fetcher<{ id: string; body: string; createdAt: string }>(
      `/api/conversations/${detail.id}/reply`,
      {
        method: 'POST',
        body: JSON.stringify({ text }),
      },
    );
    setReplying(false);
    if (res.ok) {
      // Reemplazamos el optimistic con el mensaje real.
      setDetail((d) => {
        if (!d) return d;
        return {
          ...d,
          messages: d.messages.map((m) =>
            m.id === tempId
              ? {
                  id: res.data.id,
                  body: res.data.body,
                  createdAt: res.data.createdAt,
                  direction: 'OUT',
                }
              : m,
          ),
        };
      });
      await refetchList();
    } else {
      // Rollback.
      setDetail((d) =>
        d ? { ...d, messages: d.messages.filter((m) => m.id !== tempId) } : d,
      );
      setReply(prevText);
      toast.push(t('replyFailed'), 'error');
    }
  }

  const canTakeOver = detail?.state === 'BOT' || detail?.state === 'NEEDS_HUMAN';
  const canRelease = detail?.state === 'HUMAN';

  return (
    <div className="grid gap-4 md:grid-cols-[280px_1fr]">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1 rounded-md border border-gray-200 bg-white p-2">
          {(['inbox', 'BOT', 'HUMAN', 'all'] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={cn(
                'rounded-md px-2 py-1 text-xs',
                stateFilter === s
                  ? 'bg-brand-50 font-medium text-brand-700'
                  : 'text-gray-700 hover:bg-gray-100',
              )}
              onClick={() => setStateFilter(s)}
            >
              {t(`filters.${s}` as const)}
            </button>
          ))}
        </div>

        <ul className="max-h-[70vh] divide-y divide-gray-100 overflow-auto rounded-md border border-gray-200 bg-white">
          {convos.length === 0 ? (
            <li className="p-4 text-center text-sm text-gray-500">
              {t('empty')}
            </li>
          ) : (
            convos.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className={cn(
                    'w-full px-3 py-2 text-left hover:bg-gray-50',
                    selectedId === c.id && 'bg-brand-50',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium tabular-nums text-gray-900">
                      {c.phone}
                    </p>
                    <Badge
                      variant="default"
                      className={stateStyle(c.state)}
                    >
                      {t(`state.${c.state}` as const)}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-gray-500">
                    {c.lastMessage?.body ?? '—'}
                  </p>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>

      <div className="flex min-h-[60vh] flex-col rounded-md border border-gray-200 bg-white">
        {!detail ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-gray-500">
            {t('pickOne')}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-gray-900 tabular-nums">
                  {detail.phone}
                </p>
                <p className="text-xs text-gray-500">
                  {t('messagesCount', { n: detail.messageCount })} ·{' '}
                  {t(`state.${detail.state}` as const)}
                </p>
              </div>
              <div className="flex gap-2">
                {canTakeOver ? (
                  <Button
                    variant="primary"
                    className="h-8 px-3 text-sm"
                    onClick={takeOver}
                  >
                    {t('takeover')}
                  </Button>
                ) : null}
                {canRelease ? (
                  <Button
                    variant="ghost"
                    className="h-8 px-3 text-sm"
                    onClick={release}
                  >
                    {t('release')}
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="flex-1 space-y-2 overflow-auto p-4">
              {detailLoading ? (
                <p className="text-sm text-gray-500">…</p>
              ) : (
                detail.messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    direction={m.direction}
                    body={m.body}
                    createdAt={m.createdAt}
                    locale={locale}
                  />
                ))
              )}
            </div>

            <div className="border-t border-gray-100 p-3">
              <Textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder={t('replyPlaceholder')}
                maxLength={1500}
                disabled={!canRelease && detail.state !== 'HUMAN'}
              />
              <div className="mt-2 flex items-center justify-between">
                <p className="text-xs text-gray-500">
                  {t('sendHint')}
                </p>
                <Button
                  variant="primary"
                  className="h-8 px-4 text-sm"
                  disabled={replying || !reply.trim() || detail.state !== 'HUMAN'}
                  onClick={sendReply}
                >
                  {replying ? t('sending') : t('send')}
                </Button>
              </div>
              {detail.state !== 'HUMAN' ? (
                <p className="mt-1 text-xs text-orange-700">
                  {t('takeoverBeforeReply')}
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function stateStyle(state: ConvState): string {
  switch (state) {
    case 'BOT':
      return 'bg-blue-100 text-blue-900 border-blue-300';
    case 'NEEDS_HUMAN':
      return 'bg-orange-100 text-orange-900 border-orange-300';
    case 'HUMAN':
      return 'bg-green-100 text-green-900 border-green-300';
  }
}

function MessageBubble({
  direction,
  body,
  createdAt,
  locale,
}: {
  direction: 'IN' | 'OUT';
  body: string;
  createdAt: string;
  locale: string;
}) {
  const isIn = direction === 'IN';
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(createdAt));

  return (
    <div
      className={cn(
        'flex',
        isIn ? 'justify-start' : 'justify-end',
      )}
    >
      <div
        className={cn(
          'max-w-[75%] rounded-md px-3 py-2 text-sm whitespace-pre-wrap break-words',
          isIn
            ? 'border border-gray-200 bg-gray-50 text-gray-900'
            : 'bg-brand-500 text-white',
        )}
      >
        <p>{body}</p>
        <p
          className={cn(
            'mt-1 text-[10px] tabular-nums',
            isIn ? 'text-gray-500' : 'text-white/80',
          )}
        >
          {time}
        </p>
      </div>
    </div>
  );
}
