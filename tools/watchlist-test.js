// «Посмотреть позже» (ha-addon/epg_builder/watchlist.js): разбор присланного текста и список — на заглушках
// Кинопоиска и источников. node tools/watchlist-test.js
const path=require('path');const os=require('os');const fs=require('fs');
const {createWatchlist,parseShared,catalogLink}=require('../ha-addon/epg_builder/watchlist.js');
let ok=0,bad=0;const check=(c,m)=>{c?ok++:(bad++,console.log('FAIL',m))};
const file=path.join(os.tmpdir(),'wl-'+Date.now()+'.json');
const KP={ 'дюна':{id:409424,title:'Дюна',originalTitle:'Dune',year:2021,kind:'movie',rating:7.8,genres:['фантастика'],description:'Песок',reviews:300,posterPreview:'https://kp/409424.jpg'},
  'неизвестный шедевр':{id:777,title:'Неизвестный шедевр',originalTitle:'',year:2025,kind:'movie',rating:null,genres:[],description:'',reviews:0,posterPreview:'https://kp/777.jpg'} };
const kp={enabled:()=>true, enrich:async({title})=>KP[title.toLowerCase()]||null, film:async id=>Object.values(KP).find(x=>x.id==id)||null, byImdb:async()=>null};
const SRC={'дюна':{id:'portal:1',src:'portal',title:'Дюна',year:2021,kind:'movie',poster:'/local/tizen-iptv/posters/portal_1.jpg',score:1}};
let searches=0;
const vod={searchAll:async q=>{searches++;const t=q.replace(/\s\d{4}$/,'').toLowerCase();const b=SRC[t]||null;return {best:b,results:b?[b]:[]}}, poster:async id=>'/local/tizen-iptv/posters/'+id.replace(/\W/g,'_')+'.jpg'};
const wl=createWatchlist({file,log:()=>{},kp,vod,fetchImpl:async()=>({ok:false})});
(async()=>{
 const cand=t=>parseShared(t).candidates;
 check(cand('Дюна (2021) — официальный трейлер #кино 🔥')[0]==='Дюна'&&parseShared('Дюна (2021)').year===2021,'шум и год');
 check(cand('Смотрите «Мастер и Маргарита» 2024')[0]==='Мастер и Маргарита','кавычки');
 check(cand('Видео: Интерстеллар (2014) - YouTube').includes('Интерстеллар'),'заголовок страницы');
 check(cand('Игра престолов 3 сезон смотреть онлайн')[0]==='Игра престолов','сезон');
 check(catalogLink(parseShared('https://www.kinopoisk.ru/film/409424/').urls).kp===409424,'ссылка КП');
 check(catalogLink(parseShared('https://www.imdb.com/title/tt0133093/?ref_=x').urls).imdb==='tt0133093','ссылка IMDb');
 let r=await wl.add('Дюна (2021) — официальный трейлер #кино');
 check(r.ok&&r.item.key==='kp:409424'&&r.item.found&&r.item.found.id==='portal:1','дюна найдена');
 check(r.item.posterLocal==='/local/tizen-iptv/posters/portal_1.jpg','постер источника');
 r=await wl.add('https://www.kinopoisk.ru/film/409424/');
 check(r.ok&&r.already&&wl.list().length===1,'дубль по ссылке');
 r=await wl.add('Неизвестный шедевр');
 check(r.ok&&!r.item.found&&r.item.posterLocal==='/local/tizen-iptv/posters/kp_777.jpg','нет у источников — постер КП');
 check(wl.list()[0].key==='kp:777','новые первыми');
 r=await wl.add('   ');
 check(!r.ok&&r.error==='no_title','пусто');
 SRC['неизвестный шедевр']={id:'portal:2',src:'portal',title:'Неизвестный шедевр',year:2025,kind:'movie',poster:null};
 await wl.recheck('kp:777');
 check(wl.find('kp:777').found&&wl.find('kp:777').found.id==='portal:2','появился после recheck');
 check(wl.findByFound('portal:1').key==='kp:409424','findByFound');
 check(JSON.stringify(wl.posterIds())===JSON.stringify(['portal:2','portal:1']),'posterIds');
 const wl2=createWatchlist({file,log:()=>{},kp,vod});
 check(wl2.list().length===2,'перечитано с диска');
 check(wl.remove('kp:409424')&&wl.list().length===1,'remove');
 // без Кинопоиска
 const kp0={enabled:()=>false};
 const wl3=createWatchlist({file:file+'3',log:()=>{},kp:kp0,vod});
 r=await wl3.add('Смотрите «Дюна» 2021');
 check(r.ok&&r.item.found&&r.item.key==='portal:1'&&r.item.title==='Дюна','без КП — по источнику');
 r=await wl3.add('Что-то странное');
 check(r.ok&&!r.item.found&&r.item.key.startsWith('t:'),'без КП, нигде нет');
 // год не совпал
 const vodY={searchAll:async()=>({best:{id:'portal:9',src:'portal',title:'Дюна',year:1984,kind:'movie'}}),poster:vod.poster};
 const wl4=createWatchlist({file:file+'4',log:()=>{},kp,vod:vodY});
 r=await wl4.add('Дюна');
 check(r.ok&&!r.item.found,'ремейк другого года не подставляется');
 try{fs.unlinkSync(file);fs.unlinkSync(file+'3');fs.unlinkSync(file+'4')}catch(e){}
 console.log(bad?'FAIL':'OK', ok+' проверок'+(bad?', ошибок '+bad:''));
 if(bad) process.exit(1);
})();
