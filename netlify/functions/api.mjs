import { getStore } from "@netlify/blobs";

import { createApi } from "../lib/api-core.mjs";

// 实际运行环境：Netlify Functions v2（Node 20）+ Netlify Blobs
export default createApi({ getStore });
