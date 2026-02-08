// @ts-nocheck
import * as __fd_glob_14 from "../content/docs/medicine/placeholder.mdx?collection=docs"
import * as __fd_glob_13 from "../content/docs/medicine/index.mdx?collection=docs"
import * as __fd_glob_12 from "../content/docs/general-surgery/pancreatic-cancer.mdx?collection=docs"
import * as __fd_glob_11 from "../content/docs/general-surgery/mirizzi-syndrome.mdx?collection=docs"
import * as __fd_glob_10 from "../content/docs/general-surgery/liver-cirrhosis.mdx?collection=docs"
import * as __fd_glob_9 from "../content/docs/general-surgery/liver-abscess.mdx?collection=docs"
import * as __fd_glob_8 from "../content/docs/general-surgery/jaundice.mdx?collection=docs"
import * as __fd_glob_7 from "../content/docs/general-surgery/index.mdx?collection=docs"
import * as __fd_glob_6 from "../content/docs/general-surgery/gallbladder-cancer.mdx?collection=docs"
import * as __fd_glob_5 from "../content/docs/general-surgery/cholangiocarcinoma.mdx?collection=docs"
import * as __fd_glob_4 from "../content/docs/general-surgery/acute-pancreatitis.mdx?collection=docs"
import * as __fd_glob_3 from "../content/docs/general-surgery/acute-cholecystitis.mdx?collection=docs"
import * as __fd_glob_2 from "../content/docs/index.mdx?collection=docs"
import { default as __fd_glob_1 } from "../content/docs/medicine/meta.json?collection=docs"
import { default as __fd_glob_0 } from "../content/docs/general-surgery/meta.json?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const docs = await create.docs("docs", "content/docs", {"general-surgery/meta.json": __fd_glob_0, "medicine/meta.json": __fd_glob_1, }, {"index.mdx": __fd_glob_2, "general-surgery/acute-cholecystitis.mdx": __fd_glob_3, "general-surgery/acute-pancreatitis.mdx": __fd_glob_4, "general-surgery/cholangiocarcinoma.mdx": __fd_glob_5, "general-surgery/gallbladder-cancer.mdx": __fd_glob_6, "general-surgery/index.mdx": __fd_glob_7, "general-surgery/jaundice.mdx": __fd_glob_8, "general-surgery/liver-abscess.mdx": __fd_glob_9, "general-surgery/liver-cirrhosis.mdx": __fd_glob_10, "general-surgery/mirizzi-syndrome.mdx": __fd_glob_11, "general-surgery/pancreatic-cancer.mdx": __fd_glob_12, "medicine/index.mdx": __fd_glob_13, "medicine/placeholder.mdx": __fd_glob_14, });