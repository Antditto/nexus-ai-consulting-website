import type { APIRoute } from 'astro';
import { ATLAS_SYSTEM_PROMPT } from '../../prompts/atlas-system';

// Strip HTML/XML tags from user input
function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

// Validate a single message object
function isValidMessage(msg: unknown): msg is { role: string; content: string } {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.role !== 'string' || typeof m.content !== 'string') return false;
  if (m.role !== 'user' && m.role !== 'assistant') return false;
  return true;
}

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  // Check Content-Type
  const contentType = request.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    return new Response(
      JSON.stringify({ error: 'Content-Type must be application/json' }),
      { status: 415, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Check payload size (16KB limit)
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > 16384) {
    return new Response(
      JSON.stringify({ error: 'Payload too large' }),
      { status: 413, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Parse body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (typeof body !== 'object' || body === null || !Array.isArray((body as Record<string, unknown>).messages)) {
    return new Response(
      JSON.stringify({ error: 'Request must include a messages array' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const messages = (body as { messages: unknown[] }).messages;

  // Validate turn count (max 15 round-trips = 30 messages)
  if (messages.length > 30) {
    return new Response(
      JSON.stringify({ error: 'Conversation limit reached. For a deeper conversation, book a Readiness Assessment at /contact.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Validate each message
  for (const msg of messages) {
    if (!isValidMessage(msg)) {
      return new Response(
        JSON.stringify({ error: 'Invalid message format' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // Validate the last message is from the user and within length limits
  const lastMessage = messages[messages.length - 1] as { role: string; content: string };
  if (lastMessage.role !== 'user') {
    return new Response(
      JSON.stringify({ error: 'Last message must be from user' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (lastMessage.content.length > 500) {
    return new Response(
      JSON.stringify({ error: 'Message too long. Please keep messages under 500 characters.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Sanitize all user messages — strip HTML/XML tags
  const sanitizedMessages = messages.map((msg) => {
    const m = msg as { role: string; content: string };
    return {
      role: m.role,
      content: m.role === 'user' ? stripTags(m.content) : m.content,
    };
  });

  // Get API key
  const apiKey = import.meta.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set');
    return new Response(
      JSON.stringify({ error: 'Chat is temporarily unavailable. Please try again later.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Call Anthropic API
  try {
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        temperature: 0.7,
        system: ATLAS_SYSTEM_PROMPT,
        messages: sanitizedMessages,
      }),
    });

    if (!anthropicResponse.ok) {
      const status = anthropicResponse.status;
      console.error(`Anthropic API error: ${status}`);

      // Don't leak upstream error details
      if (status === 429) {
        return new Response(
          JSON.stringify({ error: 'Atlas is taking a breather. Try again in a moment.' }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ error: 'Something went wrong. Please try again.' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const data = await anthropicResponse.json() as {
      content: Array<{ type: string; text: string }>;
    };

    // Extract text from response
    const responseText = data.content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('') || '';

    return new Response(
      JSON.stringify({ response: responseText }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Chat API error:', err);
    return new Response(
      JSON.stringify({ error: 'Something went wrong. Please try again.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

// Reject non-POST methods
export const ALL: APIRoute = async () => {
  return new Response(
    JSON.stringify({ error: 'Method not allowed' }),
    { status: 405, headers: { 'Content-Type': 'application/json', 'Allow': 'POST' } }
  );
};
