// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  docs: create.doc("docs", {"index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "medicine/index.mdx": () => import("../content/docs/medicine/index.mdx?collection=docs"), "medicine/placeholder.mdx": () => import("../content/docs/medicine/placeholder.mdx?collection=docs"), "general-surgery/index.mdx": () => import("../content/docs/general-surgery/index.mdx?collection=docs"), "general-surgery/jaundice.mdx": () => import("../content/docs/general-surgery/jaundice.mdx?collection=docs"), "general-surgery/liver-abscess.mdx": () => import("../content/docs/general-surgery/liver-abscess.mdx?collection=docs"), "general-surgery/liver-cirrhosis.mdx": () => import("../content/docs/general-surgery/liver-cirrhosis.mdx?collection=docs"), }),
};
export default browserCollections;
