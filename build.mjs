// News updater — runs on GitHub Actions every ~10 minutes.
// Fetches all sources server-side (no CORS proxies), finds the original image,
// exact publish time and full article text, and writes:
//   data/news.json      — list of articles
//   data/a/<id>.json    — full article bodies
//   data/matches.json   — matches (yesterday / today / tomorrow) from Yallakora
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import fs from "node:fs";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAX_PAGES = 260;          // article pages fetched per run
const KEEP_DAYS = 3;
const vc = new VirtualConsole();  // silence jsdom css errors

/* ---------------- SOURCES ---------------- */
const SOURCES = [
 {id:"yallakora", name:"يلا كورة", color:"#16a34a", feeds:[], pages:[
   {u:"https://www.yallakora.com/", rx:/yallakora\.com\/[^?#]*\/news\/\d+/i, s:"eg", cat:"fb"},
   {u:"https://www.yallakora.com/newslisting/%d8%a7%d9%84%d8%a3%d8%ae%d8%a8%d8%a7%d8%b1", rx:/yallakora\.com\/[^?#]*\/news\/\d+/i, s:"eg", cat:"fb"}]},
 {id:"filgoal", name:"في الجول", color:"#0f766e", feeds:[], pages:[
   {u:"https://www.filgoal.com/", rx:/filgoal\.com\/articles\/\d+/i, s:"eg", cat:"fb"},
   {u:"https://www.filgoal.com/articles/", rx:/filgoal\.com\/articles\/\d+/i, s:"eg", cat:"fb"}]},
 {id:"youm7", name:"اليوم السابع", color:"#c8102e", feeds:[
   {u:"https://www.youm7.com/rss/SectionRss?SectionID=65", s:"eg"},
   {u:"https://www.youm7.com/rss/SectionRss?SectionID=319", s:"eg", cat:"pol"},
   {u:"https://www.youm7.com/rss/SectionRss?SectionID=97", s:"eg"},
   {u:"https://www.youm7.com/rss/SectionRss?SectionID=298", s:"eg", cat:"fb"},
   {u:"https://www.youm7.com/rss/SectionRss?SectionID=296", s:"eg"},
   {u:"https://www.youm7.com/rss/SectionRss?SectionID=88", s:"ar"}]},
 {id:"shorouk", name:"الشروق", color:"#0b6e4f", feeds:[
   {u:"https://www.shorouknews.com/egypt/rss", s:"eg"},
   {u:"https://www.shorouknews.com/Economy/rss", s:"eg", cat:"eco"},
   {u:"https://www.shorouknews.com/sports/local-sports/rss", s:"eg", cat:"fb"},
   {u:"https://www.shorouknews.com/sports/international/rss", s:"ar", cat:"fb"},
   {u:"https://www.shorouknews.com/Politics/world/rss", s:"ar"},
   {u:"https://www.shorouknews.com/Politics/arab/rss", s:"ar"},
   {u:"https://www.shorouknews.com/auto/rss", s:"eg", cat:"tr"}]},
 {id:"masryalyoum", name:"المصري اليوم", color:"#1d4ed8", feeds:[{u:"https://www.almasryalyoum.com/rss/rssfeeds", s:"eg"}]},
 {id:"masrawy", name:"مصراوي", color:"#ef4444", feeds:[], pages:[{u:"https://www.masrawy.com/", rx:/masrawy\.com\/[^?#]*details\/\d{4}\/\d+\/\d+\/\d+/i, s:"eg"}]},
 {id:"elwatan", name:"الوطن", color:"#b91c1c", feeds:[], pages:[{u:"https://www.elwatannews.com/", rx:/elwatannews\.com\/news\/details\/\d+/i, s:"eg"}]},
 {id:"akhbarelyom", name:"أخبار اليوم", color:"#9a3412", feeds:[], pages:[{u:"https://akhbarelyom.com/", rx:/akhbarelyom\.com\/news\/newdetails\/\d+/i, s:"eg"}]},
 {id:"ahram", name:"بوابة الأهرام", color:"#1e3a8a", feeds:[], pages:[{u:"https://gate.ahram.org.eg/", rx:/ahram\.org\.eg\/News\/\d+\.aspx/i, s:"eg"}]},
 {id:"dostor", name:"الدستور", color:"#7c3aed", feeds:[{u:"https://www.dostor.org/rss.aspx", s:"eg"}]},
 {id:"ahramsport", name:"الأهرام الرياضي", color:"#0369a1", feeds:[{u:"https://alahramalriyadi.com/feed/", s:"eg", cat:"fb"}]},
 {id:"amwal", name:"أموال الغد", color:"#0d9488", feeds:[{u:"https://amwalalghad.com/feed/", s:"eg", cat:"eco"}]},
 {id:"bbc", name:"بي بي سي عربي", color:"#b80000", feeds:[{u:"https://feeds.bbci.co.uk/arabic/rss.xml", s:"ar"}]},
 {id:"skynews", name:"سكاي نيوز عربية", color:"#0b4ea2", feeds:[{u:"https://www.skynewsarabia.com/rss.xml", s:"ar"}]},
 {id:"aljazeera", name:"الجزيرة", color:"#c48a12", feeds:[{u:"https://www.aljazeera.net/aljazeerarss/a7c186be-1baa-4bd4-9d80-a84db769f779/73d0e1b4-532f-45ef-b135-bfdff8b8cab9", s:"ar"}]},
 {id:"alarabiya", name:"العربية", color:"#0f766e", feeds:[{u:"https://www.alarabiya.net/feed/rss2/ar.xml", s:"ar"}], pages:[{u:"https://www.alarabiya.net/", rx:/alarabiya\.net\/[^?#]*\/20\d\d\/\d\d\/\d\d\//, s:"ar"}]},
 {id:"france24", name:"فرانس 24", color:"#0ea5e9", feeds:[{u:"https://www.france24.com/ar/rss", s:"ar"}]},
 {id:"cnn", name:"سي إن إن عربية", color:"#dc2626", feeds:[{u:"https://arabic.cnn.com/api/v1/rss/rss.xml", s:"ar"}]},
 {id:"rt", name:"آر تي عربي", color:"#15803d", feeds:[{u:"https://arabic.rt.com/rss/", s:"ar"}]},
 {id:"dw", name:"دويتشه فيله", color:"#0c4a6e", feeds:[{u:"https://rss.dw.com/xml/rss-ar-all", s:"ar"}]},
 {id:"aawsat", name:"الشرق الأوسط", color:"#065f46", feeds:[{u:"https://aawsat.com/feed", s:"ar"}]},
 {id:"okaz", name:"عكاظ", color:"#1f2937", feeds:[{u:"https://www.okaz.com.sa/rssFeed/0", s:"ar"}]},
];

/* ---------------- CLASSIFY ---------------- */
const COUNTRIES = [
 ["eg",["مصر","المصري","المصرية","القاهرة","السيسي","مدبولي","الجيزة","الإسكندرية","الأهلي","الزمالك","بيراميدز"]],
 ["sa",["السعودية","السعودي","الرياض","جدة","بن سلمان","الهلال","النصر"]],
 ["ae",["الإمارات","الإماراتي","أبوظبي","أبو ظبي","دبي"]],
 ["us",["أمريكا","الأمريكي","الأمريكية","واشنطن","ترامب","الولايات المتحدة","البيت الأبيض","الكونغرس"]],
 ["gb",["بريطانيا","البريطاني","البريطانية","إنجلترا","الإنجليزي","لندن","ليفربول","أرسنال","آرسنال","مانشستر","تشيلسي","توتنهام"]],
 ["es",["إسبانيا","الإسباني","الإسبانية","مدريد","برشلونة","الليغا","الليجا"]],
 ["fr",["فرنسا","الفرنسي","الفرنسية","باريس","ماكرون","سان جيرمان"]],
 ["de",["ألمانيا","الألماني","الألمانية","برلين","بايرن","دورتموند"]],
 ["it",["إيطاليا","الإيطالي","الإيطالية","روما","ميلان","يوفنتوس","إنتر","نابولي"]],
 ["tr",["تركيا","التركي","التركية","أنقرة","إسطنبول","أردوغان","فنربخشة","جالطة سراي","جلطة سراي","بشكتاش","طرابزون"]],
 ["cn",["الصين","الصيني","الصينية","بكين"]],
 ["ru",["روسيا","الروسي","الروسية","موسكو","بوتين","الكرملين"]],
 ["ps",["فلسطين","الفلسطيني","الفلسطينية","غزة","الضفة","القدس","حماس","رفح"]],
 ["ir",["إيران","الإيراني","الإيرانية","طهران"]],
 ["ua",["أوكرانيا","الأوكراني","الأوكرانية","كييف","زيلينسكي"]],
];
const KW = {
 fb:/الأهلي|الزمالك|بيراميدز|الدوري|مباراة|مباريات|المنتخب|منتخب|ريال مدريد|برشلونة|ليفربول|محمد صلاح|كأس|هدف|أهداف|مدرب|لاعب|كرة القدم|دوري أبطال|الفيفا|فيفا|كاف|الإسماعيلي|المصري البورسعيدي|سيراميكا|تشكيل|ركلة|الملعب|نادي/,
 eco:/الدولار|الذهب|البورصة|البنك|بنك|الاقتصاد|اقتصاد|التضخم|أسعار|سعر|النفط|الفائدة|الجنيه|استثمار|الاستثمار|صندوق النقد|الصادرات|الواردات|الموازنة|الضرائب|شركة|الأسهم|العملات|اليورو/,
 tr:/مترو|المترو|قطار|القطارات|السكة الحديد|السكك الحديدية|وزارة النقل|وزير النقل|كامل الوزير|الطيران|مطار|ميناء|موانئ|مونوريل|المونوريل|الطرق|محور|كوبري|أتوبيس|الملاحة|قناة السويس|سفن/
};
const FB_LOCAL=/الأهلي|الزمالك|بيراميدز|الدوري المصري|المنتخب المصري|منتخب مصر|الفراعنة|الإسماعيلي|المصري البورسعيدي|سيراميكا|إنبي|مودرن سبورت|كأس مصر|البنك الأهلي|سموحة|الاتحاد السكندري|غزل المحلة|طلائع الجيش|المقاولون|حسام حسن|بتروجت|الجونة|فاركو|الاتحاد المصري/;
const FB_WORLD=/ريال مدريد|برشلونة|ليفربول|أرسنال|آرسنال|مانشستر|تشيلسي|توتنهام|بايرن|يوفنتوس|ميلان|إنتر|سان جيرمان|أبطال أوروبا|الدوري الإنجليزي|الدوري الإسباني|الدوري الإيطالي|الدوري الألماني|الدوري الفرنسي|الدوري التركي|الدوري السعودي|الهلال|النصر|رونالدو|ميسي/;
const EG_RX=/مصر|المصري|المصرية|القاهرة|السيسي|مدبولي|الجيزة|الإسكندرية|محافظ/;

function classify(it, feed){
  const text = it.t+" "+(it.d||"");
  let cat = feed.cat||null;
  if(!cat) cat = KW.fb.test(it.t)&&!KW.eco.test(it.t)?"fb": KW.tr.test(text)?"tr": KW.eco.test(it.t)?"eco":"pol";
  else if(cat!=="fb" && KW.tr.test(it.t)) cat="tr";
  const cs = COUNTRIES.filter(c=>c[1].some(w=>text.includes(w))).map(c=>c[0]);
  let loc;
  if(cat==="fb"){
    if(/yallakora\.com\/(egyptian-league|egypt-cup|egyptian-super-cup|african-|caf-|egypt-national|egyptian)/i.test(it.l)) loc=true;
    else if(/yallakora\.com\/(epl|la-liga|serie-a|bundesliga|ligue-1|turkish|ksa-league|uefa|champions-league|europa)/i.test(it.l)) loc=FB_LOCAL.test(it.t);
    else loc = FB_LOCAL.test(it.t) || (feed.s==="eg" && !FB_WORLD.test(it.t));
  } else loc = feed.s==="eg" ? !( /أمريكا|ترامب|روسيا|أوكرانيا|الصين|إيران|إسرائيل|غزة|أوروبا|فرنسا|ألمانيا|بريطانيا/.test(it.t) && !EG_RX.test(it.t) ) : EG_RX.test(it.t);
  if(loc && !cs.includes("eg")) cs.push("eg");
  return {cat, loc, cs};
}

/* ---------------- NET ---------------- */
async function get(url, ms=15000){
  for(let attempt=0; attempt<2; attempt++){
    const c=new AbortController(); const t=setTimeout(()=>c.abort(),ms);
    try{
      const r=await fetch(url,{signal:c.signal,redirect:"follow",headers:{"User-Agent":UA,"Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","Accept-Language":"ar,en;q=0.8"}});
      if(!r.ok) throw new Error("HTTP "+r.status);
      const buf=Buffer.from(await r.arrayBuffer());
      let cs=(r.headers.get("content-type")||"").match(/charset=([\w-]+)/i)?.[1];
      if(!cs){ const head=buf.subarray(0,2000).toString("latin1"); cs=head.match(/charset=["']?([\w-]+)/i)?.[1]||head.match(/encoding=["']([\w-]+)/i)?.[1]; }
      let txt; try{ txt=new TextDecoder(cs||"utf-8").decode(buf) }catch(e){ txt=buf.toString("utf8") }
      return {text:txt, url:r.url};
    }catch(e){ if(attempt) throw e; await new Promise(r=>setTimeout(r,800)); }
    finally{ clearTimeout(t) }
  }
}
async function pool(list, n, fn){ const q=[...list]; await Promise.all(Array.from({length:n},async()=>{ while(q.length){ const x=q.shift(); try{ await fn(x) }catch(e){} } })); }

/* ---------------- PARSE ---------------- */
const hash=s=>{let h=0;for(const c of String(s))h=(h*31+c.charCodeAt(0))|0;return Math.abs(h).toString(36)};
const clean=s=>String(s||"").replace(/\s+/g," ").trim();
const stripTags=h=>clean(new JSDOM(`<body>${String(h||"")}</body>`,{virtualConsole:vc}).window.document.body.textContent);
const abs=(u,b)=>{try{return new URL(String(u).replace(/&amp;/g,"&").trim(),b).href}catch(e){return null}};
const badImg=u=>!u||/^data:|logo|icon|placeholder|blank|default|avatar|\.gif(\?|$)|\.svg(\?|$)/i.test(u);
const normLink=l=>{ try{ const u=new URL(l); u.hash=""; ["utm_source","utm_medium","utm_campaign"].forEach(k=>u.searchParams.delete(k)); return u.href }catch(e){ return l } };

function parseFeed(xml, feed, src){
  const doc=new JSDOM(xml.replace(/^﻿/,""),{contentType:"text/xml",virtualConsole:vc}).window.document;
  let nodes=[...doc.getElementsByTagName("item")]; if(!nodes.length) nodes=[...doc.getElementsByTagName("entry")];
  const T=(el,n)=>{const x=el.getElementsByTagName(n)[0];return x?x.textContent.trim():""};
  return nodes.slice(0,40).map(it=>{
    let link=T(it,"link"); if(!link){const l=it.getElementsByTagName("link")[0]; link=l&&l.getAttribute("href")||""}
    const desc=T(it,"description")||T(it,"summary"); const content=T(it,"content:encoded")||T(it,"content");
    let img=null;
    for(const tag of ["media:content","media:thumbnail","enclosure","image"]){
      for(const n of it.getElementsByTagName(tag)){const u=n.getAttribute("url")||n.getAttribute("href")||(tag==="image"?T(n,"url")||n.textContent.trim():"");const ty=n.getAttribute("type")||"";
        if(u&&(!ty||ty.startsWith("image"))&&!/\.(mp4|mp3|m3u8)(\?|$)/i.test(u)){img=u;break}}
      if(img) break;
    }
    if(!img){ const m=(content+desc).match(/<img[^>]+src=["']([^"']+)["']/i); if(m) img=m[1]; }
    const date=T(it,"pubDate")||T(it,"published")||T(it,"updated")||T(it,"dc:date");
    let ts=Date.parse(date); if(!ts||ts>Date.now()+36e5) ts=0;
    const t=stripTags(T(it,"title")); link=normLink(link.trim());
    if(!t||!link) return null;
    return {t, l:link, ts, d:stripTags(desc).slice(0,220), img:img&&!badImg(img)?abs(img,link):null, src:src.id, feed};
  }).filter(Boolean);
}

function scrapePage(html, pg, src){
  const doc=new JSDOM(html.replace(/<script[\s\S]*?<\/script>/gi,""),{url:pg.u,virtualConsole:vc}).window.document;
  const map=new Map();
  for(const a of doc.querySelectorAll("a[href]")){
    const href=abs(a.getAttribute("href"),pg.u); if(!href||!pg.rx.test(href)) continue;
    const key=normLink(href); const e=map.get(key)||{t:"",img:null};
    let t=clean(a.getAttribute("title")||"")||clean(a.textContent);
    t=t.replace(/\s\d{1,2}\s(يناير|فبراير|مارس|أبريل|إبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر)\s\d{4}.*$/,"").trim();
    if(t.length>e.t.length && t.length<230) e.t=t;
    const im=a.querySelector("img");
    if(im && !e.img){ const u=im.getAttribute("data-src")||im.getAttribute("data-lazy-src")||im.getAttribute("data-original")||im.getAttribute("src")||(im.getAttribute("srcset")||"").split(" ")[0]; if(!badImg(u)) e.img=abs(u,pg.u); }
    map.set(key,e);
  }
  const out=[];
  for(const [l,e] of map){ if(e.t.length<18) continue; out.push({t:e.t,l,ts:0,d:"",img:e.img,src:src.id,feed:pg,scraped:1}); if(out.length>=40) break; }
  return out;
}

/* article page: og:image, publish time, description, body */
function readArticle(html, url){
  const meta=(re)=>{const m=html.match(re);return m?m[1]:null};
  const og=meta(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::src)?["'][^>]*content=["']([^"']+)["']/i)||meta(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  const tm=meta(/<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|datePublished|pubdate|publishdate|date)["'][^>]*content=["']([^"']+)["']/i)||meta(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["'](?:article:published_time|datePublished)["']/i)||meta(/"datePublished"\s*:\s*"([^"]+)"/i);
  const desc=meta(/<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]*content=["']([^"']+)["']/i);
  let ts=tm?Date.parse(tm):0; if(!ts||ts>Date.now()+36e5) ts=0;
  // jsdom parse (scripts/styles removed for speed)
  const lean=html.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<svg[\s\S]*?<\/svg>/gi,"").replace(/<noscript[\s\S]*?<\/noscript>/gi,"");
  let body="";
  try{
    const dom=new JSDOM(lean,{url,virtualConsole:vc}); const doc=dom.window.document;
    doc.querySelectorAll("img").forEach(im=>{const u=im.getAttribute("data-src")||im.getAttribute("data-lazy-src")||im.getAttribute("data-original");if(u)im.setAttribute("src",u)});
    const art=new Readability(doc,{charThreshold:250}).parse();
    if(art&&art.content) body=simplify(art.content,url);
    if(clean(body.replace(/<[^>]+>/g," ")).length<150){
      const root=doc.querySelector("[itemprop=articleBody],.article-body,.articleBody,.ArticleDetails,#articleBody,.entry-content,.news-content,article")||doc.body;
      const parts=[]; root&&root.querySelectorAll("p").forEach(p=>{const t=clean(p.textContent);if(t.length>40)parts.push(`<p>${esc(t)}</p>`)});
      if(parts.join("").length>body.length) body=parts.join("");
    }
  }catch(e){}
  return {img:og&&!badImg(og)?abs(og.replace(/&amp;/g,"&"),url):null, ts, d:desc?clean(desc.replace(/&quot;/g,'"').replace(/&amp;/g,"&")).slice(0,220):"", body};
}
const esc=s=>String(s).replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));
function simplify(html,base){
  const doc=new JSDOM(`<body>${html}</body>`,{virtualConsole:vc}).window.document; const out=[]; const seen=new Set();
  const walk=n=>{
    for(const c of n.children){
      const tg=c.tagName;
      if(tg==="IMG"){ const u=abs(c.getAttribute("src")||"",base); if(u&&!badImg(u)&&/^https?:/.test(u)&&!seen.has(u)&&!/ads?[\/_]|pixel|banner/i.test(u)){seen.add(u);out.push(`<img src="${esc(u)}">`)} continue; }
      if(/^(P|H2|H3|H4|BLOCKQUOTE|LI|FIGCAPTION)$/.test(tg)){
        c.querySelectorAll("img").forEach(im=>{const u=abs(im.getAttribute("src")||"",base);if(u&&!badImg(u)&&!seen.has(u)){seen.add(u);out.push(`<img src="${esc(u)}">`)}});
        const t=clean(c.textContent); if(t.length<2) continue;
        if(/^(اقرأ أيضا|اقرأ أيضًا|اقرأ ايضا|طالع أيضا|شاهد أيضا|تابعونا|للمزيد)/.test(t)) continue;
        const tag=tg==="P"||tg==="LI"?"p":tg==="BLOCKQUOTE"?"blockquote":tg==="FIGCAPTION"?"small":"h3";
        out.push(`<${tag}>${esc(t)}</${tag}>`); continue;
      }
      walk(c);
    }
  };
  walk(doc.body);
  return out.join("").slice(0,60000);
}

/* ---------------- MATCHES (Yallakora) ---------------- */
const pad=n=>String(n).padStart(2,"0");
function cairoDate(offsetDays){
  const d=new Date(Date.now()+offsetDays*864e5);
  const p=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"Africa/Cairo",year:"numeric",month:"numeric",day:"numeric"}).formatToParts(d).map(x=>[x.type,x.value]));
  return {key:`${p.year}-${pad(p.month)}-${pad(p.day)}`, yk:`${p.month}/${p.day}/${p.year}`};
}
export function parseMatches(doc){
  const leagues=[]; let cur=null;
  const dedup=s=>{s=clean(s);const w=s.split(" ");const h=w.length/2;if(w.length%2===0&&w.slice(0,h).join(" ")===w.slice(h).join(" "))return w.slice(0,h).join(" ");return s};
  const img=el=>{if(!el)return null;const u=el.getAttribute("data-src")||el.getAttribute("src");return u&&!/^data:/.test(u)?abs(u,"https://www.yallakora.com/"):null};
  for(const el of doc.querySelectorAll("h2, a[href*='/match/']")){
    if(el.tagName==="H2"){ cur={n:clean(el.textContent),m:[]}; leagues.push(cur); continue; }
    if(!cur) continue;
    const q=s=>el.querySelector(s);
    let a=q(".teamA p")?.textContent, b=q(".teamB p")?.textContent;
    const sc=[...el.querySelectorAll(".MResult .score")].map(x=>clean(x.textContent)).filter(x=>x!=="-"||true);
    let t=clean(q(".MResult .time")?.textContent||""), st=clean(q(".matchStatus")?.textContent||""), ch=clean(q(".channel")?.textContent||""), rd=clean(q(".date")?.textContent||"");
    let sa=sc[0]||"-", sb=sc[2]||sc[1]||"-";
    if(!a||!b){ // text fallback: "... الحالة فريقA فريقA 1 - 2 17:00 فريقB فريقB"
      const tx=clean(el.textContent); const m=tx.match(/(لم تبدأ|انتهت|جارية|مؤجلة|ألغيت|الشوط الأول|الشوط الثاني|استراحة|\d{1,3}')\s+(.+?)\s+(\d+|-)\s+-\s+(\d+|-)\s+(\d{1,2}:\d{2})\s+(.+)$/);
      if(!m) continue; st=st||m[1]; a=m[2]; sa=m[3]; sb=m[4]; t=t||m[5]; b=m[6];
    }
    a=dedup(a); b=dedup(b); if(!a||!b) continue;
    if(!/\d/.test(sa)) sa="-"; if(!/\d/.test(sb)) sb="-";
    cur.m.push({a,b,al:img(q(".teamA img")),bl:img(q(".teamB img")),sa,sb,t,st,ch,rd,id:(el.getAttribute("href").match(/match\/(\d+)/)||[])[1]});
  }
  const seen=new Set();
  return leagues.filter(l=>l.m.length).map(l=>({...l,m:l.m.filter(x=>{if(!x.id||seen.has(x.id))return !x.id;seen.add(x.id);return true})})).filter(l=>l.m.length);
}
async function buildMatches(){
  let prev={days:{}}; try{prev=JSON.parse(fs.readFileSync("data/matches.json","utf8"))}catch(e){}
  const days={};
  for(const off of [-1,0,1,2]){
    const d=cairoDate(off);
    try{
      const {text}=await get(`https://www.yallakora.com/match-center/?date=${d.yk}`,20000);
      const doc=new JSDOM(text.replace(/<script[\s\S]*?<\/script>/gi,""),{url:"https://www.yallakora.com/",virtualConsole:vc}).window.document;
      days[d.key]=parseMatches(doc);
      console.log("matches",d.key,days[d.key].reduce((s,l)=>s+l.m.length,0));
    }catch(e){ console.log("matches fail",d.key,e.message); if(prev.days&&prev.days[d.key]) days[d.key]=prev.days[d.key]; }
  }
  fs.writeFileSync("data/matches.json",JSON.stringify({updated:Date.now(),days}));
}

/* ---------------- MAIN ---------------- */
async function main(){
  fs.mkdirSync("data/a",{recursive:true});
  let prev={items:[]}; try{prev=JSON.parse(fs.readFileSync("data/state.json","utf8"))}catch(e){}
  const old=new Map((prev.items||[]).map(a=>[a.id,a]));
  const fails=prev.fails||{};
  const stat={};
  const raw=[];
  const jobs=[]; for(const s of SOURCES){ for(const f of s.feeds) jobs.push({s,f}); for(const p of (s.pages||[])) jobs.push({s,f:p,page:1}); }
  await pool(jobs,10,async({s,f,page})=>{
    try{ const {text}=await get(f.u); const items=page?scrapePage(text,f,s):parseFeed(text,f,s); raw.push(...items); stat[s.id]=(stat[s.id]||0)+items.length; }
    catch(e){ console.log("source fail",s.id,f.u,e.message) }
  });
  console.log("raw items",raw.length, JSON.stringify(stat));

  // merge with old, dedupe
  const now=Date.now(); const byId=new Map();
  for(const r of raw){
    const id=hash(r.l); const o=old.get(id);
    if(o){ byId.set(id,{...o, t:r.t.length>8?r.t:o.t}); continue; }
    if(byId.has(id)) continue;
    const c=classify(r,r.feed);
    byId.set(id,{id,t:r.t,l:r.l,ts:r.ts,d:r.d,img:r.img,src:r.src,...c,seen:now,pg:0,scr:r.scraped?1:0});
  }
  for(const [id,o] of old){ if(!byId.has(id)) byId.set(id,o); }

  // article pages for new items (image, time, body)
  const need=[...byId.values()].filter(a=>!a.pg && (fails[a.id]||0)<3).sort((a,b)=>(b.ts||b.seen)-(a.ts||a.seen)).slice(0,MAX_PAGES);
  console.log("article pages to fetch",need.length);
  let ok=0;
  await pool(need,12,async a=>{
    try{
      const {text,url}=await get(a.l,15000);
      const r=readArticle(text,url||a.l);
      if(!a.img && r.img) a.img=r.img;
      if(r.ts && (a.scr || !a.ts)) a.ts=r.ts;
      if(!a.d && r.d) a.d=r.d;
      if(r.body && r.body.replace(/<[^>]+>/g,"").length>150){ fs.writeFileSync(`data/a/${a.id}.json`,JSON.stringify({h:r.body})); a.b=1; }
      a.pg=1; ok++;
    }catch(e){ fails[a.id]=(fails[a.id]||0)+1; if(fails[a.id]>=3) a.pg=1; }
  });
  console.log("article pages ok",ok);

  // drop default/logo images repeated within a source
  const cnt={}; for(const a of byId.values()) if(a.img){const k=a.src+"|"+a.img.split("?")[0];cnt[k]=(cnt[k]||0)+1}
  for(const a of byId.values()) if(a.img && cnt[a.src+"|"+a.img.split("?")[0]]>=3) a.img=null;

  // finalize
  const cutoff=now-KEEP_DAYS*864e5; const seenT=new Set(); const out=[];
  const list=[...byId.values()].map(a=>({...a,ts:a.ts||a.seen})).filter(a=>a.ts>cutoff).sort((a,b)=>b.ts-a.ts);
  for(const a of list){
    const k=a.t.replace(/[^؀-ۿa-z0-9]/gi,"").slice(0,40); if(seenT.has(k)) continue; seenT.add(k);
    out.push(a); if(out.length>=900) break;
  }
  // prune bodies
  const keep=new Set(out.map(a=>a.id+".json"));
  for(const f of fs.readdirSync("data/a")) if(!keep.has(f)) fs.unlinkSync("data/a/"+f);
  for(const k of Object.keys(fails)) if(!byId.has(k)) delete fails[k];

  const srcs=Object.fromEntries(SOURCES.map(s=>[s.id,[s.name,s.color]]));
  const shown=out.filter(a=>a.img);
  console.log("final",out.length,"with image",shown.length);
  fs.writeFileSync("data/state.json",JSON.stringify({updated:now,items:out.map(({feed,...a})=>a),fails}));
  const lean=shown.slice(0,650).map(a=>({id:a.id,t:a.t,l:a.l,ts:a.ts,d:(a.d||"").slice(0,150),img:a.img,src:a.src,cat:a.cat,loc:a.loc?1:0,cs:a.cs,b:a.b?1:0}));
  fs.writeFileSync("data/news.json",JSON.stringify({updated:now,srcs,items:lean}));
}

const only=process.argv[2];
if(only!=="matches") await main();
if(only!=="news") await buildMatches();
