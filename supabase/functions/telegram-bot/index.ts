// telegram-bot — your Open Brain's Telegram interface
// Runs on Supabase's servers. Telegram forwards every message sent to your
// bot here; this code saves it, searches it, or lists your recent thoughts.

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Secrets — read from Supabase's secret manager, never written in code.
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const ALLOWED_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

// These two are provided by Supabase automatically.
// The service role key skips your Level 2 security rule, which is why
// every query below filters by OWNER_USER_ID by hand.
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
)

// Always answer Telegram with 200 so it never retries the same message.
function ok() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function reply(chatId: number, text: string) {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000), // Telegram's limit is 4096 characters
        disable_web_page_preview: true,
      }),
    },
  )
  if (!res.ok) console.error('sendMessage failed:', res.status, await res.text())
}

function preview(text: string, max = 200) {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

function formatList(rows: { content: string; created_at: string }[]) {
  return rows
    .map((r, i) => {
      const date = new Date(r.created_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
      return `${i + 1}. ${preview(r.content)}  (${date})`
    })
    .join('\n\n')
}

// Stops characters like % and _ from acting as wildcards in a search.
function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (m) => '\\' + m)
}

const HELP = [
  'Your Open Brain is listening.',
  '',
  '• Send any text → saved to your brain',
  '• /search word  (or  ?word) → find matching thoughts',
  '• /recent → your last 5 thoughts',
].join('\n')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return ok()

  let chatId: number | undefined

  try {
    const update = await req.json()
    const message = update.message ?? update.edited_message
    if (!message?.chat?.id) return ok() // not a chat message — ignore

    chatId = message.chat.id as number
    const text: string = (message.text ?? '').trim()

    // Setup mode: no chat ID saved yet → tell the owner what it is.
    if (!ALLOWED_CHAT_ID) {
      await reply(
        chatId,
        `Almost there! Your chat ID is:\n\n${chatId}\n\n` +
          'Add it in Supabase → Edge Functions → Secrets as TELEGRAM_CHAT_ID, ' +
          'then message me again.',
      )
      return ok()
    }

    // Only obey the owner's chat. Everyone else is silently ignored.
    if (String(chatId) !== ALLOWED_CHAT_ID.trim()) {
      console.log('Ignored message from chat', chatId)
      return ok()
    }

    if (!OWNER_USER_ID) {
      await reply(chatId, 'Setup problem: the OWNER_USER_ID secret is missing.')
      return ok()
    }

    if (!text) {
      await reply(chatId, 'I can only save text messages for now.')
      return ok()
    }

    // /start or /help
    if (/^\/(start|help)(@\S+)?$/i.test(text)) {
      await reply(chatId, HELP)
      return ok()
    }

    // /recent
    if (/^\/recent(@\S+)?$/i.test(text)) {
      const { data, error } = await supabase
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .order('created_at', { ascending: false })
        .limit(5)
      if (error) throw error

      await reply(
        chatId,
        data && data.length
          ? `🕒 Your last ${data.length} thoughts:\n\n${formatList(data)}`
          : 'Your brain is empty so far. Send me a thought!',
      )
      return ok()
    }

    // /search something   or   ?something
    const searchMatch = text.match(/^\/search(@\S+)?\s*([\s\S]*)$/i)
    if (searchMatch || text.startsWith('?')) {
      const query = (searchMatch ? searchMatch[2] : text.slice(1)).trim()
      if (!query) {
        await reply(chatId, 'What should I search for? Try: /search coffee')
        return ok()
      }

      const { data, error } = await supabase
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .ilike('content', `%${escapeLike(query)}%`)
        .order('created_at', { ascending: false })
        .limit(5)
      if (error) throw error

      await reply(
        chatId,
        data && data.length
          ? `🔎 Found ${data.length} for "${query}":\n\n${formatList(data)}`
          : `Nothing found for "${query}".`,
      )
      return ok()
    }

    // Anything else starting with / is an unknown command.
    if (text.startsWith('/')) {
      await reply(chatId, "I don't know that command.\n\n" + HELP)
      return ok()
    }

    // Otherwise: save it as a new thought.
    const { error } = await supabase.from('thoughts').insert({
      user_id: OWNER_USER_ID,
      content: text,
      source: 'telegram',
      metadata: {
        telegram_message_id: message.message_id,
        sent_at: new Date((message.date ?? Date.now() / 1000) * 1000).toISOString(),
      },
    })
    if (error) throw error

    await reply(chatId, '🧠 Saved to your brain')
  } catch (err) {
    console.error('telegram-bot error:', err)
    if (chatId) {
      await reply(chatId, '⚠️ Something went wrong on my end. Check the function logs in Supabase.')
        .catch(() => {})
    }
  }

  return ok() // always 200, even on errors
})