// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  docs: create.doc("docs", {"index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "general-surgery/acute-cholecystitis.mdx": () => import("../content/docs/general-surgery/acute-cholecystitis.mdx?collection=docs"), "general-surgery/acute-pancreatitis.mdx": () => import("../content/docs/general-surgery/acute-pancreatitis.mdx?collection=docs"), "general-surgery/cholangiocarcinoma.mdx": () => import("../content/docs/general-surgery/cholangiocarcinoma.mdx?collection=docs"), "general-surgery/gallbladder-cancer.mdx": () => import("../content/docs/general-surgery/gallbladder-cancer.mdx?collection=docs"), "general-surgery/index.mdx": () => import("../content/docs/general-surgery/index.mdx?collection=docs"), "general-surgery/jaundice.mdx": () => import("../content/docs/general-surgery/jaundice.mdx?collection=docs"), "general-surgery/liver-abscess.mdx": () => import("../content/docs/general-surgery/liver-abscess.mdx?collection=docs"), "general-surgery/liver-cirrhosis.mdx": () => import("../content/docs/general-surgery/liver-cirrhosis.mdx?collection=docs"), "general-surgery/mirizzi-syndrome.mdx": () => import("../content/docs/general-surgery/mirizzi-syndrome.mdx?collection=docs"), "general-surgery/pancreatic-cancer.mdx": () => import("../content/docs/general-surgery/pancreatic-cancer.mdx?collection=docs"), "medicine/index.mdx": () => import("../content/docs/medicine/index.mdx?collection=docs"), "medicine/placeholder.mdx": () => import("../content/docs/medicine/placeholder.mdx?collection=docs"), }),
};
export default browserCollections;