import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from '../scripts/lib/rss.mjs';

describe('parseFeed images', () => {
  test('extracts RSS media thumbnails', () => {
    const [entry] = parseFeed(`
      <rss><channel><item>
        <title>Story</title>
        <link>https://example.com/story</link>
        <media:thumbnail url="https://cdn.example.com/story.jpg" />
      </item></channel></rss>
    `);

    assert.equal(entry.imageUrl, 'https://cdn.example.com/story.jpg');
  });

  test('extracts an image embedded in HTML content', () => {
    const [entry] = parseFeed(`
      <feed><entry>
        <title>Story</title>
        <link rel="alternate" href="https://example.com/story" />
        <content><![CDATA[<p>Intro</p><img src="https://cdn.example.com/embedded.png">]]></content>
      </entry></feed>
    `);

    assert.equal(entry.imageUrl, 'https://cdn.example.com/embedded.png');
  });

  test('rejects non-http image URLs', () => {
    const [entry] = parseFeed(`
      <rss><channel><item>
        <title>Story</title>
        <link>https://example.com/story</link>
        <enclosure url="javascript:alert(1)" type="image/jpeg" />
      </item></channel></rss>
    `);

    assert.equal(entry.imageUrl, null);
  });
});
