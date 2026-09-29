// ============================================================================
// CAPTURE-URL — paste a link, the server fetches the page and keeps the text
// ============================================================================
// WHY THIS RUNS ON THE SERVER: a web browser is not allowed to fetch pages
// from other websites (a security rule called CORS). A server has no such
// limit, so your app hands the link here and this function does the fetching.
//
// For now it saves the readable text as-is. Summarising comes in Level 5.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const MAX_BYTES = 3_000_000      // don't swallow enormous pages
const MAX_THOUGHT_CHARS = 20_000 // the thought row gets this much; full text goes to thought_sources

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)) } catch { return ' ' } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return ' ' } })
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&(#39|apos);/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// Strip a web page down to its title and readable text.
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : ''

  // Most articles wrap their real content in <article> or <main>. Use it if found.
  let body = html
  const main = html.match(/<article[\s\S]*?<\/article>/i) ?? html.match(/<main[\s\S]*?<\/main>/i)
  if (main && main[0].length > 1000) body = main[0]

  body = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')

  const text = decodeEntities(body)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { title, text }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // Who is asking? Read from their login token, never from the request body.
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return json({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json()
    if (!url || typeof url !== 'string') return json({ ok: false, error: 'A url is required' }, 400)

    // Only http(s) links.
    let parsed: URL
    try { parsed = new URL(url.trim()) } catch {
      return json({ ok: false, error: 'That is not a valid web address' }, 400)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return json({ ok: false, error: 'Only http and https links are supported' }, 400)
    }

    // Fetch the page, identifying as a normal browser.
    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })

    if (!pageRes.ok) {
      return json({
        ok: false,
        error: `That page returned an error (HTTP ${pageRes.status}). It may require a login or block automated readers.`,
      }, 422)
    }

    const contentType = pageRes.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return json({
        ok: false,
        error: `That link is a ${contentType.split(';')[0] || 'file'}, not a web page. For PDFs, use the PDF tab.`,
      }, 415)
    }

    const raw = await pageRes.text()
    if (raw.length > MAX_BYTES) return json({ ok: false, error: 'That page is too large to process' }, 413)

    const { title: foundTitle, text } = htmlToText(raw)
    const title = foundTitle || parsed.hostname

    if (text.length < 200) {
      return json({
        ok: false,
        error:
          'Almost no readable text was found. The page probably builds itself with ' +
          'JavaScript after loading, which a server cannot see. Paste the text in manually instead.',
      }, 422)
    }

    const content = `🔗 ${title}\n${parsed.hostname}\n\n${text.slice(0, MAX_THOUGHT_CHARS)}`

    // Save with the admin client, stamped with the caller's own user id.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const { data: thought, error: saveError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content,
        source: 'url',
        metadata: { title, url: parsed.toString(), hostname: parsed.hostname },
      })
      .select('id')
      .single()
    if (saveError) throw saveError

    // Keep the full text too. Non-fatal: the thought is already saved either way.
    const { error: srcError } = await admin.from('thought_sources').insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: text,
      source_kind: 'web',
      char_count: text.length,
      truncated: false,
    })
    if (srcError) console.log('[url] thought_sources insert skipped (non-fatal):', srcError.message)

    return json({
      ok: true,
      title,
      hostname: parsed.hostname,
      chars: text.length,
      preview: content.slice(0, 240) + '…',
    })
  } catch (err) {
    console.error('[url] Failed:', err)
    const msg = String(err).includes('timeout') ? 'That page took too long to respond.' : String((err as any)?.message ?? err)
    return json({ ok: false, error: msg }, 500)
  }
})