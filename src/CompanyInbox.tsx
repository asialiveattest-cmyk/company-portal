import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, MessageCircle, Search, Send } from 'lucide-react';
import { supabase } from './supabase';
import './company-inbox.css';

type InboxRole = 'user' | 'super_admin';
type ConversationSummary = {
  conversation_id: string;
  user_id: string;
  user_name: string;
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
};
type CompanyMessage = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
};

function messageTime(value: string) {
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function conversationTime(value: string | null) {
  if (!value) return '';
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function CompanyInbox({
  userId,
  role,
  active,
  onUnreadChange,
}: {
  userId: string;
  role: InboxRole;
  active: boolean;
  onUnreadChange: (count: number) => void;
}) {
  const [conversationId, setConversationId] = useState('');
  const [selectedConversationId, setSelectedConversationId] = useState('');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [messages, setMessages] = useState<CompanyMessage[]>([]);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadAdminInbox = useCallback(async () => {
    const { data, error: loadError } = await supabase.rpc('list_company_conversations');
    if (loadError) {
      setError(loadError.message);
      return;
    }
    const rows = (data || []) as ConversationSummary[];
    setConversations(rows);
    onUnreadChange(rows.reduce((total, row) => total + Number(row.unread_count || 0), 0));
    setError('');
  }, [onUnreadChange]);

  const loadUserUnread = useCallback(async (id: string) => {
    const { count, error: countError } = await supabase.from('company_messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', id)
      .neq('sender_id', userId)
      .is('read_at', null);
    if (countError) {
      setError(countError.message);
      return;
    }
    onUnreadChange(count || 0);
  }, [onUnreadChange, userId]);

  const loadMessages = useCallback(async (id: string) => {
    setMessagesLoading(true);
    const { data, error: loadError } = await supabase.from('company_messages')
      .select('id,conversation_id,sender_id,body,created_at,read_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    setMessagesLoading(false);
    if (loadError) {
      setError(loadError.message);
      return;
    }
    setMessages((data || []) as CompanyMessage[]);
    setError('');
  }, []);

  const markRead = useCallback(async (id: string) => {
    const { error: readError } = await supabase.rpc('mark_company_messages_read', {
      p_conversation_id: id,
    });
    if (readError) {
      setError(readError.message);
      return;
    }
    if (role === 'super_admin') await loadAdminInbox();
    else await loadUserUnread(id);
  }, [loadAdminInbox, loadUserUnread, role]);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      setLoading(true);
      setError('');
      if (role === 'super_admin') {
        await loadAdminInbox();
      } else {
        const { data, error: conversationError } = await supabase.rpc('get_or_create_company_conversation');
        if (conversationError) {
          if (!cancelled) setError(conversationError.message);
        } else if (!cancelled && data) {
          setConversationId(data);
          setSelectedConversationId(data);
          setMobileChatOpen(true);
          await loadUserUnread(data);
        }
      }
      if (!cancelled) setLoading(false);
    }
    void initialize();
    return () => { cancelled = true; };
  }, [loadAdminInbox, loadUserUnread, role, userId]);

  useEffect(() => {
    if (!active || !selectedConversationId) return;
    void loadMessages(selectedConversationId);
    void markRead(selectedConversationId);
  }, [active, loadMessages, markRead, selectedConversationId]);

  useEffect(() => {
    if (role === 'user' && !conversationId) return;
    const channel = supabase.channel(`company-inbox-${userId}-${crypto.randomUUID()}`);
    const filter = role === 'user' ? { filter: `conversation_id=eq.${conversationId}` } : {};
    channel.on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'company_messages',
      ...filter,
    }, (payload) => {
      const eventConversationId = (payload.new as Partial<CompanyMessage>).conversation_id
        || (payload.old as Partial<CompanyMessage>).conversation_id;
      if (role === 'super_admin') void loadAdminInbox();
      else if (conversationId) void loadUserUnread(conversationId);
      if (active && eventConversationId && eventConversationId === selectedConversationId) {
        void loadMessages(eventConversationId);
        void markRead(eventConversationId);
      }
    });
    if (role === 'super_admin') {
      channel.on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'company_conversations',
      }, () => { void loadAdminInbox(); });
    }
    channel.subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [active, conversationId, loadAdminInbox, loadMessages, loadUserUnread, markRead, role, selectedConversationId, userId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, selectedConversationId]);

  const selectedConversation = conversations.find((row) => row.conversation_id === selectedConversationId);
  const filteredConversations = useMemo(() => conversations.filter((row) => {
    const query = search.trim().toLocaleLowerCase();
    return !query || row.user_name.toLocaleLowerCase().includes(query);
  }), [conversations, search]);

  function openConversation(id: string) {
    setMessages([]);
    setSelectedConversationId(id);
    setMobileChatOpen(true);
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !selectedConversationId || sending) return;
    setSending(true);
    setError('');
    const { error: sendError } = await supabase.rpc('send_company_message', {
      p_conversation_id: selectedConversationId,
      p_body: body,
    });
    setSending(false);
    if (sendError) {
      setError(sendError.message);
      return;
    }
    setDraft('');
    await loadMessages(selectedConversationId);
    if (role === 'super_admin') await loadAdminInbox();
  }

  if (!active) return null;

  return (
    <section className={`company-inbox ${mobileChatOpen ? 'mobile-chat-open' : ''}`} aria-label="Messages inbox">
      {role === 'super_admin' && (
        <aside className="inbox-sidebar">
          <div className="inbox-list-heading">
            <div>
              <span className="inbox-eyebrow">PRIVATE MESSAGES</span>
              <h1>Inbox</h1>
            </div>
            <span className="inbox-total">{conversations.length}</span>
          </div>
          <label className="inbox-search">
            <Search size={17} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search users" aria-label="Search users" />
          </label>
          {error && <div className="inbox-error" role="alert">{error}</div>}
          <div className="inbox-conversation-list">
            {loading ? <div className="inbox-list-state">Loading conversations…</div>
              : filteredConversations.length === 0 ? <div className="inbox-list-state">{search ? 'No users found.' : 'No conversations yet.'}</div>
                : filteredConversations.map((row) => (
                  <button
                    className={`inbox-conversation ${selectedConversationId === row.conversation_id ? 'selected' : ''}`}
                    key={row.conversation_id}
                    onClick={() => openConversation(row.conversation_id)}
                  >
                    <span className="inbox-avatar">{(row.user_name || 'U').slice(0, 1).toUpperCase()}</span>
                    <span className="inbox-conversation-copy">
                      <span className="inbox-conversation-top"><b>{row.user_name || 'User'}</b><time>{conversationTime(row.last_message_at)}</time></span>
                      <span className="inbox-conversation-bottom"><span>{row.last_message || 'No messages yet'}</span>{Number(row.unread_count) > 0 && <i>{row.unread_count}</i>}</span>
                    </span>
                  </button>
                ))}
          </div>
        </aside>
      )}

      <div className="inbox-chat">
        {selectedConversationId ? (
          <>
            <header className="inbox-chat-header">
              {role === 'super_admin' && <button className="inbox-back" aria-label="Back to conversations" onClick={() => setMobileChatOpen(false)}><ArrowLeft size={18} /></button>}
              <span className="inbox-avatar">{role === 'user' ? 'C' : (selectedConversation?.user_name || 'U').slice(0, 1).toUpperCase()}</span>
              <div><b>{role === 'user' ? 'Company Support' : selectedConversation?.user_name || 'Conversation'}</b><small>{role === 'user' ? 'Private conversation with the company' : 'Private user conversation'}</small></div>
            </header>
            {error && <div className="inbox-error" role="alert">{error}</div>}
            <div className="inbox-messages" aria-live="polite">
              {messagesLoading && messages.length === 0 ? <div className="inbox-chat-state">Loading messages…</div>
                : messages.length === 0 ? <div className="inbox-chat-state"><MessageCircle size={30} /><b>No messages yet</b><span>Send a message to start this conversation.</span></div>
                  : messages.map((message) => {
                    const outgoing = message.sender_id === userId;
                    return (
                      <div className={`inbox-message-row ${outgoing ? 'outgoing' : 'incoming'}`} key={message.id}>
                        <article className="inbox-bubble">
                          <p>{message.body}</p>
                          <time>{messageTime(message.created_at)}</time>
                        </article>
                      </div>
                    );
                  })}
              <div ref={bottomRef} />
            </div>
            {error && !messages.length && <div className="inbox-error" role="alert">{error}</div>}
            <form className="inbox-compose" onSubmit={(event) => void sendMessage(event)}>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Write a message…"
                aria-label="Write a message"
                maxLength={5000}
                autoComplete="off"
              />
              <button type="submit" disabled={!draft.trim() || sending} aria-label="Send message">
                <Send size={18} /> <span>{sending ? 'Sending…' : 'Send'}</span>
              </button>
            </form>
          </>
        ) : (
          <div className="inbox-chat-state inbox-select-state">
            <MessageCircle size={34} />
            <b>Select a conversation</b>
            <span>Choose a user to view and reply to their messages.</span>
            {error && <span role="alert">{error}</span>}
          </div>
        )}
      </div>
    </section>
  );
}
