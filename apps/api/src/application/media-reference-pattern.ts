/**
 * The one place the reference scan's idea of "a media URL" is written down.
 *
 * Deliberately `/media/<uuid>` and not `/api/media/<uuid>`: the Web app serves
 * `/api/media/<id>` and relays it, and the API's own route is
 * `/api/v1/media/<id>` — which is the address a client that talks to the API
 * directly (the Flutter app) stores in a body. A pattern that matched only one
 * of them marked live cover images and avatars as orphans.
 *
 * Matching the path rather than a full URL also covers an absolute address, and
 * a stray `/media/<uuid>` in a code block would count as a reference, which is
 * the direction a mistake should go: it refuses a delete instead of allowing
 * one.
 */
export const MEDIA_SRC_PATTERN =
  /\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi;
