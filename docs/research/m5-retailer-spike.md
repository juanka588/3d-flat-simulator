# M5.0 Spike: retailer product and 3D sources (2026-10-27)

Scope: can the automatic designer place only real, purchasable products, using data and 3D models from French retailers, through the user's local scene server (`apps/server`, 127.0.0.1) for personal use? Nothing from a retailer may be served by the GitHub Pages site or committed.

Method: read-only probes with an identifying User-Agent (`3d-flat-simulator-research/0.1 (personal spike)`), about 25 requests in total. Probes: robots.txt of 8 hosts, 1 IKEA product page, 1 IKEA search call, 1 ranged GET (100 bytes) and 1 HEAD on an IKEA GLB, homepage status for 7 retailers. No bulk access, no bypass. I stopped on every block (DataDome / Akamai 403). Statements marked **[unverified]** come from memory or from pages I could not fetch; confirm them before relying on them.

Legal caveat: this is an engineering reading of the terms, not legal advice.

## 1. Summary table

| Provider | Product data | Prices (TTC) | Exact dims | 3D | Official access | ToS stance | Verdict |
|---|---|---|---|---|---|---|---|
| **IKEA FR** | Rich. Public JSON search and product page. | Yes (EUR) | Yes, structured: `width/depth/height/length/weight` with `value` plus text. Search items also have `itemMeasureReferenceText` ("77x147 cm"). | **Yes**: GLB/glTF per product (LOD 1-3, Draco variants), `schema.org/3DModel` JSON-LD, CORS `*` | No public product API, no affiliate programme found [unverified]. Partnership requests go to a corporate email only. | Grey. CGU art. 7 allows reproduction "seulement ... pour un usage personnel et privé". No explicit bot clause found. robots.txt disallows `*/search/?q=*` and `*/3daas-rotera/*` on www; web-api host explicitly allows `/dimma/assets/`. | **Grey (b). Best first connector.** |
| **Leroy Merlin FR** | Not reachable by bots | n/a | n/a | n/a (3D/AR presence [unverified]) | Affiliate network [unverified] | Not read: CGU URL returned 403 | Blocked (DataDome). Feed only if user joins affiliate. |
| **Maisons du Monde** | Not reachable by bots | n/a | n/a | AR on app [unverified] | Affiliate [unverified] | Not read (DataDome 403 on homepage and robots.txt) | Blocked. Feed only. |
| **Castorama FR** | Homepage reachable (200, CDN "fasterize"). Product JSON not probed. | likely | likely in text/facets [unverified] | Not found [unverified] | Affiliate [unverified] | Mentions légales has no IP/scraping clause. CGV pages not read. robots.txt disallows `/search?*`, `/casto-browse-mfe/api/`, Crawl-delay 10 for some bots. | Grey/prohibited by robots for API paths. Low priority. |
| **Conforama FR** | Homepage 200 (Cloudflare) | likely | [unverified] | Not found | Affiliate [unverified] | CGU is a PDF I did not read. robots.txt disallows `*recherche-conforama*`, `*productCode=*`. | Not assessed beyond robots. Feed only. |
| **BUT** | Homepage 200 (DataDome header "protected") | likely | [unverified] | Has a 3D kitchen configurator (robots mentions it); no product models found | Affiliate [unverified] | CGU not found. robots.txt disallows `/recherche/`, `/Catalog/`, `/Api/Rest/`. | Blocked or disallowed. Feed only. |
| **La Redoute** | Not reachable (Cloudflare 403) | n/a | n/a | n/a | Affiliate [unverified] | Not read | Blocked. Feed only. |
| **Darty** (appliances) | Not reachable (Akamai 403) | n/a | n/a | n/a | Affiliate [unverified] | Not read | Blocked. Feed only. |
| **Affiliate feeds (Awin etc.)** | SKU, title, description, price, currency, deep link, image URL, stock, brand, category; optional size/colour/material/EAN/MPN | Yes | **Weak**: only optional free-text `size`; no structured w/d/h standard | No | **Yes, official.** Awin publisher signup open to individuals; each advertiser approves separately. | Permitted within each programme's terms (feed use is for promoting the products, not for building a design tool: check) | Official but data-poor for dims and 3D. |
| **Manufacturer / BIM libraries** | Archiproducts, BIMobject, 3D Warehouse | n/a | Yes, in the model | Yes (RFA/IFC/SKP/OBJ, often) | Per-site accounts, B2B oriented | Archiproducts terms forbid to "reproduce, duplicate, copy, sell, resell or otherwise commercially exploit the content"; no BIM licence text found. BIMobject terms URL returned 404 (not read). | Per-brand manual use only. Not an automatic source. |

## 2. Evidence by provider

### 2.1 IKEA France (the only provider with real 3D and structured dims)

Verified by probing:

- **Product page** `https://www.ikea.com/fr/fr/p/kallax-etagere-blanc-80275887/` returned 200 with a plain UA (1.18 MB HTML). Its JSON-LD blocks were `BreadcrumbList` and `3DModel` (no `Product` block seen in my parse). The page also embeds the package measurements: for example `width 41 cm`, `height 16 cm`, `length 150 cm`, `weight 20.30 kg`, each as `{text, value}`. These are the packaging boxes, not the assembled item, so the assembled size comes from search ("77x147 cm") and the page's dimension section. `priceCurrency: EUR` is present.
- **3D**: the `3DModel` JSON-LD has `encoding[]` entries with `contentUrl` and `encodingFormat: model/gltf-binary`. URL pattern:
  `https://web-api.ikea.com/dimma/assets/1.2/{articleNo}/{PS01_S01_NV01}/{iqp1|iqp2|iqp3|rqp1..3}/{glb|glb_draco|gltf}/{hash}-{articleNo}_{...}_v1.4.11.glb?cn=pip`
  There are also "geomagical" simplified models. LOD names (iqp = interactive quality, rqp = render quality) are my inference from the filenames.
- **Fetchability**: a ranged GET returned `206`, `content-type: model/gltf-binary`, `access-control-allow-origin: *`, `cache-control: public,max-age=3600`, total size 1,098,936 bytes, magic `glTF`. A HEAD request returned **403** from Cloudflare, so use GET only. Not retried further.
- **robots.txt** `https://web-api.ikea.com/robots.txt`: `User-agent: * / Disallow: / / Allow: /dimma/assets/`. The asset path is therefore explicitly allowed for crawlers.
- **robots.txt** `https://www.ikea.com/robots.txt`: for `*` it disallows `*/search/?q=*`, `*/search/products/?q=*`, `*/3daas-rotera/*`, `*/global/assets/rotera/*`, `*/recommendations/*` and others. `/fr/fr/p/...` product pages are not disallowed.
- **Search endpoint** (the one the site's listing uses): `POST https://sik.search.blue.cdtapps.com/fr/fr/search?c=listaf&v=20240110`, JSON body with `searchParameters.input`, `components[].window.size/offset`. One request with query "kallax" returned 200 with `access-control-allow-origin: *`. Each item has `name`, `typeName`, `itemMeasureReferenceText`, `mainImageUrl`, `pipUrl`, `allProductImage[]` (with alt text and type). Filters expose colour and width/height/depth buckets. `https://sik.search.blue.cdtapps.com/robots.txt` says `Allow: /`. Price fields were not inspected in my truncated output; confirm in implementation. This is an undocumented internal endpoint: it can change or be rate-limited without notice.
- **Terms**: CGU of IKEA.fr (`https://www.ikea.com/fr/fr/customer-service/terms-conditions/conditions-generales-utilisations-pub9f645241/`), article 7 "Propriété intellectuelle":
  - "Tous les droits d'auteur, droits sur la conception graphique, les représentations et les marques commerciales" remain IKEA's.
  - "La reproduction, en intégralité ou en partie, de tous documents, images, contenus publiés sur le Site est seulement autorisée aux fins exclusives d'information pour un usage personnel et privé."
  - A targeted search of the same page (via an LLM-based fetch, so not guaranteed) found no mention of robot, scraping, extraction or automated access. The only commercial-use prohibition found concerns the chat.
  - Interpretation: personal/private reproduction is permitted for "information" purposes. Displaying a model privately in one's own local app is arguably within this, but streaming it into a design tool is not clearly "information". No explicit bot ban does not equal permission. Classified as grey (b), not (a).
- **Programme/API**: no public IKEA product API or developer portal found. Partnership page (`https://www.ikea.com/fr/fr/customer-service/knowledge/articles/13g09e1g-f553-4g16-gc03-5d17g3665dcg.html`) only gives a corporate contact email and does not mention affiliation or data. Affiliate programme: none found, [unverified].
- **Variants**: colours exist as separate articles (each with its own page and article number, hence its own GLB). Material is in text. Stock is per store and needs a store id [unverified].

### 2.2 Other retailers (bot protection)

Homepage / robots.txt probes (single GET each, then stopped):

| Host | Status | Protection |
|---|---|---|
| leroymerlin.fr | 403 | DataDome (`x-datadome: protected`) |
| maisonsdumonde.com | 403 (also on robots.txt) | DataDome |
| laredoute.fr | 403 (robots.txt 403) | Cloudflare |
| darty.com | 403 (robots.txt 403) | Akamai (`ak_p` timing header) |
| castorama.fr | 200 | CDN/Fasterize; robots.txt `https://www.castorama.fr/robots.txt` |
| conforama.fr | 200 | Cloudflare |
| but.fr | 200 | `x-datadome: protected` on a 200 (soft protection) |

Making these work from a script would mean defeating anti-bot protections, which I did not do and which the brief forbids. Conclusion: do not build scraping connectors for them. Use official feeds (below) or the user's pasted URL.

robots.txt highlights that matter for a connector: Leroy Merlin disallows `/recherche*`, `/v3/search/search.do`, `*/navigation/api/autocomplete`; Castorama disallows `/search?*`, `/casto-browse-mfe/api/`; Conforama disallows `*recherche-conforama*`; BUT disallows `/recherche/`, `/Api/Rest/`, `/Catalog/`. So even the "public internal" search/API endpoints are explicitly off-limits for crawlers at these four retailers. IKEA is the exception only for its separate search host.

Terms I could read: Castorama "Mentions légales" (`https://www.castorama.fr/mentions-legales`) has no IP/scraping clause; its CGV links are `/cgv-achat-en-ligne` and `/cgv-marketplace` (not read). Conforama's CGU is a PDF linked from `https://www.conforama.fr/informations/conditions-generales-de-vente` (not read). Leroy Merlin, Maisons du Monde, BUT, La Redoute, Darty terms: not read (blocked or URL not found). **[unverified]**: assume standard French "reproduction interdite sans autorisation" and no-extraction clauses (database right, art. L341-1 CPI) apply.

### 2.3 Affiliate networks and feeds

- **Awin** (verified): individuals may join; "aucun type de compte spécifique n'est requis" (`https://www.awin.com/fr/editeurs`). Each advertiser programme sets its own acceptance criteria. The Awin publisher page itself does not describe feeds. A third-party guide (`https://wisepim.com/guides/product-feed-optimization/awin`) lists the feed contents: required `aw_product_id` (SKU), `product_name`, `description`, `search_price`, `aw_deep_link`, `merchant_image_url`, `brand_name`, `category_name`, `delivery_cost`, `delivery_time`, `in_stock` (1/0); optional `size`, `colour`, `material`, `mpn`, `ean`, `rrp_price`, `currency`, `alternate_image`, `product_group_id`. CSV or XML over HTTPS, refreshed daily by default. Secondary source: check Awin's own docs.
- **Which retailer is on which network**: I could not verify any of these (search tool returned nothing useful; Awin's advertiser showcase did not list them). From memory, **[unverified]**: Leroy Merlin, Castorama, Conforama, BUT, Maisons du Monde, La Redoute and Darty each run programmes on Awin, Effiliation, Kwanko or similar; IKEA France has no public affiliate programme. The user must check inside the network dashboards.
- **Fit for us**: feeds give SKU, title, price (TTC), stock, image and buy link, which is exactly "real purchasable product". They do not give structured w/d/h (at best a free-text `size`) and no 3D. Using feed data in a design/visualisation tool is not the usual "promote the product" use; programme terms must be checked per advertiser, and affiliate clicks may be required to use the deep link **[unverified]**.
- Effiliation, Kwanko, Partnerize, CJ, Rakuten: not researched in this spike. Same model, different signup and approval per advertiser.

### 2.4 Manufacturer, BIM and 3D libraries

- **Archiproducts** (`https://www.archiproducts.com/en/terms-and-conditions`): the user may not "reproduce, duplicate, copy, sell, resell or otherwise commercially exploit the content of the Site". No clause specific to 3D/BIM downloads found; their BIM platform is separate. No public API found.
- **BIMobject**: terms and help URLs I tried returned 404 or connection reset; API and licence **unverified**. Typically B2B, free account, per-brand licence, formats RFA/IFC/SKP.
- **SketchUp 3D Warehouse** (`https://sketchup.trimble.com/en/products/3d-warehouse`, redirect not followed): licence and API not verified. User-uploaded models of mixed quality and licence.
- **IKEA Planner 3D assets**: no public access found; the product-page GLBs above are the practical IKEA 3D source.

## 3. Alternatives that keep "real products"

| Option | Legality | Effort | Quality |
|---|---|---|---|
| **A. IKEA connector via local server** (search endpoint + page JSON-LD + GLB on demand) | Grey (b): personal/private use clause plus allowed asset path, no explicit bot ban; undocumented endpoints; IKEA could change or block. Display only, never redistribute. | Medium (1-2 days) | Best: true product geometry and textures, exact dims, price, photo, URL |
| **B. User pastes a product URL; server fetches that one page; reads schema.org JSON-LD** (`Product`, `3DModel`) | Grey-to-fine: one human-initiated request, equivalent to the user opening the page. Fails on DataDome sites (403) | Low (half a day, generic) | Varies by site: JSON-LD `Product` usually gives name, price, image, sometimes `width/height/depth` (`QuantitativeValue`); 3D only where `3DModel` is published |
| **C. Affiliate feed + CC0/parametric mesh scaled to dims** | Official (a), subject to each programme's terms | Medium-high: signup per advertiser, feed ingest, dims often missing so extra LLM/text parsing | Real SKU, price, photo; geometry is a lookalike |
| **D. Manufacturer BIM objects, manual download** | Per-licence, usually fine for personal use if downloaded manually | Low per item, does not scale | Exact geometry, often heavy and not web-optimised |

## 4. Recommended connector architecture

All retailer code lives in `apps/server` only; the web app sees a normalised `ProductRecord` and a same-origin model URL.

```ts
interface ProductProvider {
  id: string;                       // "ikea-fr", "pasted-url", "awin-feed"
  capabilities: { search: boolean; model3d: boolean; dims: 'structured'|'text'|'none' };
  search(q: string, opts: {limit: number; category?: string}): Promise<ProductRecord[]>;
  get(sku: string): Promise<ProductRecord>;
  fetchModel?(sku: string): Promise<ReadableStream>;   // GLB bytes, server-side only
}
// ProductRecord = M5 backlog fields: provider, sku, name, price, currency, url, dims{w,d,h}, category, styleTags, photoUrl, modelRef?
```

- **Model delivery**: browser requests `http://127.0.0.1:<port>/assets/{provider}/{sku}.glb`; the server fetches upstream with GET (HEAD is blocked at IKEA), pipes the bytes, and sets `Cache-Control: no-store` toward the browser. Even though IKEA sends CORS `*`, proxy anyway: it hides upstream, lets us enforce the rate limit, and keeps the same-origin rule that Pages never touches retailer URLs.
- **Fallback chain** (from the backlog): provider model, else CC0 mesh scaled to dims, else parametric box at exact dims. The product record always remains (price, URL, dims) even without 3D.
- **Credentials**: IKEA needs none. For feed providers, take the token or feed URL from environment variables or a gitignored `apps/server/.env.local`, never from the browser, never in scenes or the repo. Redact in logs. The MCP tools never return the credential. The Pages build has no code path to the connectors (enforce with a CI check that `apps/web` has no import from provider modules and that no retailer hostnames appear in the built bundle).
- **Caching**: memory-only LRU with TTL (search 10 min, product 1 h, GLB bytes 1 h, hard size cap e.g. 200 MB), cleared on restart. No disk persistence, nothing under `git` or `public/`. Scenes store only the `{provider, sku}` reference plus our own derived data (price snapshot, dims), and re-resolve the model on load. (Storing price/dims is facts data; keep it small. Do not store product photos or GLBs.)
- **Politeness**: identifying User-Agent, one concurrent request per host, 1-2 s gap, exponential backoff, circuit breaker on 403/429 that disables the provider for the session and reports to the LLM, honour robots.txt per path in code (fetch and cache each host's robots.txt, refuse disallowed paths).
- **Tool surface**: `search_products`, `get_product`, `place_product` accept only `{provider, sku}` pairs returned by earlier calls. The server rejects unknown pairs, enforcing "no invented furniture".

## 5. Risks

1. **ToS/legal**: IKEA is grey, not permitted. Personal use only; do not share scenes that embed models, screenshots with models, or the app build. A rights holder could object; risk is low for private local use.
2. **Fragility**: the sik search endpoint, the `dimma` asset URLs and page structure are undocumented and may change or be blocked (Cloudflare already blocks HEAD). Expect breakage; keep the fallback chain.
3. **Anti-bot**: 5 of 7 other retailers block simple clients. Bypassing is out of scope and risks account and legal trouble.
4. **Dimension semantics**: IKEA page measurements include package sizes; assembled sizes come from search/page text. Need a parser plus a sanity check against GLB bounding boxes.
5. **Mesh weight**: IKEA GLBs are about 1 MB each at LOD 1 and Draco-compressed variants exist; need `DRACOLoader` in the viewer and a LOD choice.
6. **Price/stock staleness**: TTL cache, and stock is store-specific. Show prices as "indicative, as of <time>".
7. **Affiliate feed terms** and approval delays are unknown until the user applies.
8. **Pages leak**: any accidental import of provider code or a cached asset into the public build would breach the stated rule; guard in CI.

## 6. Recommendation

1. **First: IKEA FR connector (grey, personal use)** with search, product page parse, and GLB streaming. It is the only provider giving real 3D, structured dims, EUR prices and photos with no key.
2. **Second: generic "paste a product URL" provider** (JSON-LD `Product`, optional `3DModel`), which covers Castorama or Conforama pages when reachable, degrades gracefully with a clear error on DataDome sites, and gives the user an escape hatch for any retailer. Product record then uses the CC0/parametric fallback for geometry.
3. **Later, only if the user wants it**: join Awin (free for individuals) and apply to the retailers already on it (verify which) to get official feeds for Leroy Merlin, Maisons du Monde, Conforama, BUT, La Redoute, Darty. Combine with parametric/CC0 meshes at dims parsed from titles/descriptions.
4. Do not build scrapers for DataDome/Akamai-protected sites.

## 7. Open questions for the user

1. Are you comfortable with the grey status of IKEA (personal and private use only, no sharing of scenes with embedded models, may break without notice)? If not, IKEA drops to "paste a URL, data only".
2. Do you want to sign up with Awin (or another network) and apply to retailers for official feeds, accepting that feeds have no 3D and weak dimensions?
3. Is "paste a product URL" acceptable as the way to add non-IKEA products, with CC0/parametric geometry at the dimensions from the page?
4. Should scenes persist only `{provider, sku}` references plus price and dimension snapshots (no photos or models), so a shared scene never carries retailer assets?
