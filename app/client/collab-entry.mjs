// TLLM*meet: browser bundle for the shared editor and whiteboard.
// Built into public/sfu/TllmCollabLib.js with `npm run build:collab` (the output is committed).
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { QuillBinding } from 'y-quill';
import QuillCursors from 'quill-cursors';

export { Y, syncProtocol, awarenessProtocol, encoding, decoding, QuillBinding, QuillCursors };
