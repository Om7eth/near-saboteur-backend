var De=Object.create;var F=Object.defineProperty;var Fe=Object.getOwnPropertyDescriptor;var Ge=Object.getOwnPropertyNames;var Ue=Object.getPrototypeOf,Re=Object.prototype.hasOwnProperty;var ze=(r,e,t)=>e in r?F(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t;var d=(r,e)=>()=>(e||r((e={exports:{}}).exports,e),e.exports);var Be=(r,e,t,n)=>{if(e&&typeof e=="object"||typeof e=="function")for(let s of Ge(e))!Re.call(r,s)&&s!==t&&F(r,s,{get:()=>e[s],enumerable:!(n=Fe(e,s))||n.enumerable});return r};var He=(r,e,t)=>(t=r!=null?De(Ue(r)):{},Be(e||!r||!r.__esModule?F(t,"default",{value:r,enumerable:!0}):t,r));var i=(r,e,t)=>ze(r,typeof e!="symbol"?e+"":e,t);var U=d(S=>{"use strict";Object.defineProperty(S,"__esModule",{value:!0});S.LocalStorage=void 0;var G=class{async get(e){return typeof window>"u"?null:localStorage.getItem(e)}async set(e,t){typeof window>"u"||localStorage.setItem(e,t)}async remove(e){typeof window>"u"||localStorage.removeItem(e)}};S.LocalStorage=G});var ve=d(R=>{"use strict";Object.defineProperty(R,"__esModule",{value:!0});R.encodeBase58=Je;var xe="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";function Je(r){if(r.length===0)return"";let e=0,t=0;for(;t<r.length&&r[t]===0;)e++,t++;let n=[0];for(;t<r.length;t++){let o=r[t];for(let a=0;a<n.length;++a)o+=n[a]<<8,n[a]=o%58,o=o/58|0;for(;o>0;)n.push(o%58),o=o/58|0}for(;n.length>0&&n[n.length-1]===0;)n.pop();let s="";for(let o=0;o<e;o++)s+=xe[0];for(let o=n.length-1;o>=0;--o)s+=xe[n[o]];return s}});var x=d(C=>{"use strict";Object.defineProperty(C,"__esModule",{value:!0});C.nearActionsToConnectorActions=void 0;var Ve=ve(),Ye=r=>{try{return JSON.parse(new TextDecoder().decode(r))}catch{return r}},Xe=r=>r.enum!=null?r.enum==="fullAccess":"fullAccess"in r,Ze=r=>r.enum!=null?r.enum==="AccountId":"AccountId"in r,Qe=r=>r.map(e=>{if("type"in e)return e;if(e.signedDelegate)throw new Error("SignedDelegate actions cannot be sent through the wallet connector; wallets sign delegates via signDelegateActions");if(e.functionCall)return{type:"FunctionCall",params:{methodName:e.functionCall.methodName,args:Ye(e.functionCall.args),gas:e.functionCall.gas.toString(),deposit:e.functionCall.deposit.toString()}};if(e.deployGlobalContract)return{type:"DeployGlobalContract",params:{code:e.deployGlobalContract.code,deployMode:Ze(e.deployGlobalContract.deployMode)?"AccountId":"CodeHash"}};if(e.createAccount)return{type:"CreateAccount"};if(e.useGlobalContract){let t=e.useGlobalContract.contractIdentifier;return{type:"UseGlobalContract",params:{contractIdentifier:t.AccountId!=null?{accountId:t.AccountId}:{codeHash:(0,Ve.encodeBase58)(t.CodeHash)}}}}if(e.deployContract)return{type:"DeployContract",params:{code:e.deployContract.code}};if(e.deleteAccount)return{type:"DeleteAccount",params:{beneficiaryId:e.deleteAccount.beneficiaryId}};if(e.deleteKey)return{type:"DeleteKey",params:{publicKey:e.deleteKey.publicKey.toString()}};if(e.transfer)return{type:"Transfer",params:{deposit:e.transfer.deposit.toString()}};if(e.stake)return{type:"Stake",params:{stake:e.stake.stake.toString(),publicKey:e.stake.publicKey.toString()}};if(e.addKey){let{permission:t}=e.addKey.accessKey,n;if(t.functionCall)n={receiverId:t.functionCall.receiverId,allowance:t.functionCall.allowance?.toString(),methodNames:t.functionCall.methodNames};else if(Xe(t))n="FullAccess";else throw new Error("Unsupported access-key permission on AddKey: only functionCall and fullAccess can be sent through the wallet connector (pass a ConnectorAction otherwise)");return{type:"AddKey",params:{publicKey:e.addKey.publicKey.toString(),accessKey:{nonce:Number(e.addKey.accessKey.nonce),permission:n}}}}throw new Error("Unsupported action type")});C.nearActionsToConnectorActions=Qe});var v=d(m=>{"use strict";Object.defineProperty(m,"__esModule",{value:!0});m.isGasKeyAction=void 0;m.assertGasKeyActionsSupported=tt;var et=r=>r.type==="TransferToGasKey"||r.type==="WithdrawFromGasKey"||r.type==="AddKey"&&r.params.gasKeyInfo!=null;m.isGasKeyAction=et;function tt(r,e,t){if(r?.gasKeys)return;let n=e.filter(m.isGasKeyAction).map(s=>s.type);if(n.length!==0)throw new Error(`${t} does not advertise gas-key support (manifest features.gasKeys), so ${[...new Set(n)].join(", ")} cannot be sent through it; a wallet that does not know gasKeyInfo could add a plain key instead. Sign locally with a full-access key, or use a wallet whose manifest sets features.gasKeys.`)}});var _=d(P=>{"use strict";Object.defineProperty(P,"__esModule",{value:!0});P.uuid4=void 0;var nt=()=>typeof window<"u"&&typeof window.crypto<"u"&&typeof window.crypto.randomUUID=="function"?window.crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(r){let e=Math.random()*16|0;return(r==="x"?e:e&3|8).toString(16)});P.uuid4=nt});var J=d(I=>{"use strict";Object.defineProperty(I,"__esModule",{value:!0});I.ParentFrameWallet=void 0;var z=x(),B=v(),st=_(),H=class{constructor(e,t){i(this,"connector");i(this,"manifest");this.connector=e,this.manifest=t}callParentFrame(e,t){let n=(0,st.uuid4)();return window.parent.postMessage({type:"near-wallet-injected-request",id:n,method:e,params:t},"*"),new Promise((s,o)=>{let a=l=>{l.data.type==="near-wallet-injected-response"&&l.data.id===n&&(window.removeEventListener("message",a),l.data.success?s(l.data.result):o(l.data.error))};window.addEventListener("message",a)})}async signIn(e){let t=await this.callParentFrame("near:signIn",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey});return Array.isArray(t)?t:[t]}async signInAndSignMessage(e){let t=await this.callParentFrame("near:signInAndSignMessage",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey,messageParams:e.messageParams});return Array.isArray(t)?t:[t]}async signOut(e){let t={...e,network:e?.network??this.connector.network};await this.callParentFrame("near:signOut",t)}async getAccounts(e){let t={...e,network:e?.network??this.connector.network};return this.callParentFrame("near:getAccounts",t)}async signAndSendTransaction(e){let t=(0,z.nearActionsToConnectorActions)(e.actions);(0,B.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let n={...e,actions:t,network:e.network??this.connector.network};return this.callParentFrame("near:signAndSendTransaction",n)}async signAndSendTransactions(e){let t=e.transactions.map(s=>({actions:(0,z.nearActionsToConnectorActions)(s.actions),receiverId:s.receiverId}));(0,B.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(s=>s.actions),this.manifest.name);let n={...e,transactions:t,network:e.network??this.connector.network};return this.callParentFrame("near:signAndSendTransactions",n)}async signMessage(e){let t={...e,network:e.network??this.connector.network};return this.callParentFrame("near:signMessage",t)}async signDelegateActions(e){let t={...e,delegateActions:e.delegateActions.map(n=>({...n,actions:(0,z.nearActionsToConnectorActions)(n.actions)})),network:e.network||this.connector.network};return(0,B.assertGasKeyActionsSupported)(this.manifest.features,t.delegateActions.flatMap(n=>n.actions),this.manifest.name),this.callParentFrame("near:signDelegateActions",t)}};I.ParentFrameWallet=H});var V=d(M=>{"use strict";Object.defineProperty(M,"__esModule",{value:!0});M.parseUrl=void 0;var rt=r=>{try{return new URL(r)}catch{return null}};M.parseUrl=rt});var ke=d(E=>{"use strict";Object.defineProperty(E,"__esModule",{value:!0});E.copyText=void 0;var ot=async r=>{try{await navigator.clipboard.writeText(r);return}catch{}let e=document.createElement("textarea");e.value=r,e.setAttribute("readonly",""),e.style.position="fixed",e.style.opacity="0",document.body.appendChild(e),e.select();try{if(!document.execCommand("copy"))throw new Error("Copy failed")}finally{e.remove()}};E.copyText=ot});var Se=d(w=>{"use strict";Object.defineProperty(w,"__esModule",{value:!0});w.openExternalLink=w.openTelegramLink=w.isTelegramMiniApp=void 0;var Y=()=>{let r=window?.Telegram?.WebApp;return!r||!r.platform||r.platform==="unknown"?null:r},at=()=>{try{return location.hash.includes("tgWebAppData")?!0:!!sessionStorage.getItem("__telegram__initParams")}catch{return!1}},it=()=>typeof window>"u"?!1:!!Y()||!!window.TelegramWebviewProxy||at();w.isTelegramMiniApp=it;var Ae=(r,e)=>{let t=window.TelegramWebviewProxy;if(t?.postEvent)return t.postEvent(r,JSON.stringify(e));let n=window.external;if(n&&"notify"in n)return n.notify(JSON.stringify({eventType:r,eventData:e}));window.parent!==window&&window.parent.postMessage(JSON.stringify({eventType:r,eventData:e}),"https://web.telegram.org")},lt=r=>{let e=Y();if(e)return e.openTelegramLink(r.toString());Ae("web_app_open_tg_link",{path_full:r.pathname+r.search})};w.openTelegramLink=lt;var ct=r=>{let e=Y();if(e)return e.openLink(r.toString());Ae("web_app_open_link",{url:r.toString()})};w.openExternalLink=ct});var Z=d($=>{"use strict";Object.defineProperty($,"__esModule",{value:!0});$.EventEmitter=void 0;var X=class{constructor(){i(this,"events",{})}on(e,t){this.events[e]||(this.events[e]=[]),this.events[e].push(t)}emit(e,t){this.events[e]?.forEach(n=>n(t))}off(e,t){this.events[e]=this.events[e]?.filter(n=>n!==t)}once(e,t){let n=s=>{t(s),this.off(e,n)};this.on(e,n)}removeAllListeners(e){e?delete this.events[e]:this.events={}}};$.EventEmitter=X});var W=d(N=>{"use strict";Object.defineProperty(N,"__esModule",{value:!0});N.escapeHtml=Ce;N.html=dt;function Ce(r){return r.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}var Q=Symbol("htmlTag");function dt(r,...e){let t=r[0];for(let n=0;n<e.length;n++){for(let s of Array.isArray(e[n])?e[n]:[e[n]]){let o=s?.[Q]?s[Q]:Ce(String(s??""));t+=o}t+=r[n+1]}return Object.freeze({[Q]:t,get html(){return t}})}});var Pe=d(j=>{"use strict";Object.defineProperty(j,"__esModule",{value:!0});j.css=void 0;var ut=r=>`
${r} * {
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
  -ms-overflow-style: none; 
  scrollbar-width: none; 
  color: #fff;
}

${r} *::-webkit-scrollbar { 
  display: none;
}

${r} p,
${r} h1,
${r} h2,
${r} h3,
${r} h4,
${r} h5,
${r} h6 {
  margin: 0;
}

${r} .modal-container {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 100000000;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    flex-direction: column;
    transition: opacity 0.2s ease-in-out;
}

@media (max-width: 600px) {
  ${r} .modal-container {
    justify-content: flex-end;
  }
}

${r} .modal-content {
  display: flex;
  flex-direction: column;
  align-items: center;

  max-width: 420px;
  max-height: 615px;
  width: 100%;
  border-radius: 24px;
  background: #0d0d0d;
  border: 1.5px solid rgba(255, 255, 255, 0.1);
  transition: transform 0.2s ease-in-out;
}

@media (max-width: 600px) {
  ${r} .modal-content {
    max-width: 100%;
    width: 100%;
    max-height: 80%;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border: none;
    border-top: 1.5px solid rgba(255, 255, 255, 0.1);
  }
}


${r} .modal-header {
  display: flex;
  padding: 16px;
  gap: 16px;
  align-self: stretch;
  align-items: center;
  justify-content: center;
  position: relative;
}

${r} .modal-header button {
  position: absolute;
  right: 16px;
  top: 16px;
  width: 32px;
  height: 32px;
  border-radius: 12px;
  cursor: pointer;
  transition: background 0.2s ease-in-out;
  border: none;
  background: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

${r} .modal-header button:hover {
  background: rgba(255, 255, 255, 0.04);
}
  
${r} .modal-header p {
  color: #fff;
  text-align: center;
  font-size: 24px;
  font-style: normal;
  font-weight: 600;
  line-height: normal;
  margin: 0;
}


${r} .modal-body {
  display: flex;
  padding: 16px;
  flex-direction: column;
  align-items: flex-start;
  text-align: center;
  gap: 8px;
  overflow: auto;

  border-radius: 24px;
  background: rgba(255, 255, 255, 0.08);
  width: 100%;
  flex: 1;
}

${r} .modal-body textarea {
  width: 100%;
  padding: 12px;
  border-radius: 12px;
  background: #0d0d0d;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.1);
  outline: none;
  font-size: 16px;
  transition: background 0.2s ease-in-out;
  font-family: monospace;
  font-size: 12px;
}

${r} .modal-body button {
  width: 100%;
  padding: 12px;
  border-radius: 12px;
  background: #fff;
  color: #000;
  border: none;
  cursor: pointer;
  font-size: 16px;
  transition: background 0.2s ease-in-out;
  margin-top: 16px;
}

${r} .footer {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 16px 24px;
  color: #fff;
  gap: 12px;
}

${r} .modal-body p {
  color: rgba(255, 255, 255, 0.9);
  text-align: center;
  font-size: 16px;
  font-style: normal;
  font-weight: 500;
  line-height: normal;
  letter-spacing: -0.8px;
}

${r} .footer img {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}

${r} .get-wallet-link {
  color: rgba(255, 255, 255, 0.5);
  text-align: center;
  font-size: 16px;
  font-style: normal;
  font-weight: 500;
  margin-left: auto;
  text-decoration: none;
  transition: color 0.2s ease-in-out;
  cursor: pointer;
}
  
${r} .get-wallet-link:hover {
  color: rgba(255, 255, 255, 1);
}


${r} .connect-item {
  display: flex;
  padding: 8px;
  align-items: center;
  gap: 12px;
  align-self: stretch;
  cursor: pointer;

  transition: background 0.2s ease-in-out;
  border-radius: 24px;
}

${r} .connect-item img {
  width: 48px;
  height: 48px;
  border-radius: 16px;
  object-fit: cover;
  flex-shrink: 0;
}

${r} .connect-item-info {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  text-align: left;
  flex: 1;
  margin-top: -2px;
}

${r} .connect-item-info .wallet-address {
  color: rgba(255, 255, 255, 0.5);
  font-size: 14px;
  font-style: normal;
  font-weight: 400;
  line-height: normal;
}

${r} .connect-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

${r} .connect-item img {
  width: 48px;
  height: 48px;
  border-radius: 16px;
  object-fit: cover;
}

${r} .connect-item p {
  color: rgba(255, 255, 255, 0.9);
  text-align: center;
  font-size: 18px;
  font-style: normal;
  font-weight: 600;
  line-height: normal;
  letter-spacing: -0.36px;
  margin: 0;
}
`;j.css=ut});var te=d(O=>{"use strict";Object.defineProperty(O,"__esModule",{value:!0});O.Popup=void 0;var ht=Pe(),wt=W(),_e=`n${Math.random().toString(36).substring(2,15)}`;if(typeof document<"u"){let r=document.createElement("style");r.textContent=(0,ht.css)(`.${_e}`),document.head.append(r)}var ee=class{constructor(e){i(this,"delegate");i(this,"isClosed",!1);i(this,"root",document.createElement("div"));i(this,"state",{});i(this,"disposables",[]);this.delegate=e}get dom(){return(0,wt.html)``}addListener(e,t,n){let s=typeof e=="string"?this.root.querySelector(e):e;s&&(s.addEventListener(t,n),this.disposables.push(()=>s.removeEventListener(t,n)))}handlers(){this.disposables.forEach(s=>s()),this.disposables=[];let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.onclick=s=>s.stopPropagation(),e.onclick=()=>{this.delegate.onReject(),this.destroy()};let n=s=>{s.key==="Escape"&&(this.delegate.onReject(),this.destroy())};document.addEventListener("keydown",n),this.disposables.push(()=>document.removeEventListener("keydown",n))}update(e){this.state={...this.state,...e},this.root.innerHTML=this.dom.html,this.handlers()}create({show:e=!0}){this.root.className=`${_e} hot-connector-popup`,this.root.style.display="none",this.root.innerHTML=this.dom.html,document.body.append(this.root),this.handlers();let t=this.root.querySelector(".modal-container"),n=this.root.querySelector(".modal-content");n.style.transform="translateY(50px)",t.style.opacity="0",e&&setTimeout(()=>this.show(),10)}show(){let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.style.transform="translateY(50px)",e.style.opacity="0",this.root.style.display="block",setTimeout(()=>{t.style.transform="translateY(0)",e.style.opacity="1"},100)}hide(){let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.style.transform="translateY(50px)",e.style.opacity="0",setTimeout(()=>{this.root.style.display="none"},200)}destroy(){this.isClosed||(this.isClosed=!0,this.disposables.forEach(e=>e()),this.disposables=[],this.hide(),setTimeout(()=>{this.root.remove()},200))}};O.Popup=ee});var Ie=d(T=>{"use strict";Object.defineProperty(T,"__esModule",{value:!0});T.IframeWalletPopup=void 0;var ne=W(),gt=te(),se=class extends gt.Popup{constructor(t){super(t);i(this,"delegate");this.delegate=t}handlers(){super.handlers(),this.addListener("button","click",()=>this.delegate.onApprove())}create(){super.create({show:!1}),this.root.querySelector(".modal-body").appendChild(this.delegate.iframe),this.delegate.iframe.style.width="100%",this.delegate.iframe.style.height="720px",this.delegate.iframe.style.border="none"}get footer(){if(!this.delegate.footer)return"";let{icon:t,heading:n}=this.delegate.footer;return(0,ne.html)`
      <div class="footer">
        ${t?(0,ne.html)`<img src="${t}" alt="${n}" />`:""}
        <p>${n}</p>
      </div>
    `}get dom(){return(0,ne.html)`<div class="modal-container">
      <div class="modal-content">
        <div class="modal-body" style="padding: 0; overflow: auto;"></div>
        ${this.footer}
      </div>
    </div>`}};T.IframeWalletPopup=se});var Me=d(L=>{"use strict";Object.defineProperty(L,"__esModule",{value:!0});L.NEAR_CONNECT_VERSION=void 0;L.NEAR_CONNECT_VERSION="0.12.0"});var Ee=d(re=>{"use strict";Object.defineProperty(re,"__esModule",{value:!0});var ft=Me();async function pt(r){let e=await r.executor.getAllStorage(),t=r.executor.connector.providers,n=r.executor.manifest,s=r.id,o=r.code.replaceAll(".localStorage",".sandboxedLocalStorage").replaceAll("window.top","window.selector").replaceAll("window.open","window.selector.open"),a=r.cspNonce?` nonce="${r.cspNonce.replace(/[^A-Za-z0-9+/=]/g,"")}"`:"";return`
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body>
      <div id="root"></div>

      <style>
        :root {
          --background-color: rgb(40, 40, 40);
          --text-color: rgb(255, 255, 255);
          --border-color: rgb(209, 209, 209);
        }

        * {
          font-family: system-ui, Avenir, Helvetica, Arial, sans-serif
        }

        body, html {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
          background-color: var(--background-color);
          color: var(--text-color);
        }

        #root {
          display: none;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          width: 100vw;
          background: radial-gradient(circle at center, #2c2c2c 0%, #1a1a1a 100%);
          text-align: center;
        }

        #root * {
          box-sizing: border-box;
          font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
          line-height: 1.5;
          color-scheme: light dark;
          color: rgb(255, 255, 255);
          font-synthesis: none;
          text-rendering: optimizeLegibility;
          -webkit-font-smoothing: antialiased;
        }

        .prompt-container img {
          width: 100px;
          height: 100px;
          object-fit: cover;
          border-radius: 12px;
        }

        .prompt-container h1 {
          margin: 0;
          font-size: 24px;
          font-weight: 600;
          margin-top: 16px;
        }

        .prompt-container p {
          margin: 0;
          font-size: 16px;
          font-weight: 500;
          color: rgb(209, 209, 209);
        }

        .prompt-container button {
          background-color: #131313;
          border: none;
          border-radius: 12px;
          padding: 12px 24px;
          cursor: pointer;
          transition: border-color 0.25s;
          color: #fff;
          outline: none;
          font-size: 14px;
          font-weight: 500;
          font-family: inherit;
          margin-top: 16px;
        }
      </style>


      <script${a}>
      window.sandboxedLocalStorage = (() => {
        let storage = ${JSON.stringify(e)}

        return {
          setItem: function(key, value) {
            window.selector.storage.set(key, value)
            storage[key] = value || '';
          },
          getItem: function(key) {
            return key in storage ? storage[key] : null;
          },
          removeItem: function(key) {
            window.selector.storage.remove(key)
            delete storage[key];
          },
          get length() {
            return Object.keys(storage).length;
          },
          key: function(i) {
            const keys = Object.keys(storage);
            return keys[i] || null;
          },
        };
      })();

      const showPrompt = async (args) => {
        const root = document.getElementById("root");   
        root.style.display = "flex";
        root.innerHTML = \`
          <div class="prompt-container">
            <img src="${n.icon}" />
            <h1>${n.name}</h1>
            <p>\${args.title}</p>
            <button>\${args.button}</button>
          </div>
        \`;

        return new Promise((resolve) => {
          root.querySelector("button")?.addEventListener("click", () => {
            root.innerHTML = "";
            resolve(true);
          });
        });
      }

      class ProxyWindow {
        constructor(url, features) {
          this.closed = false;
          this.windowIdPromise = window.selector.call("open", { url, features });

          window.addEventListener("message", async (event) => {            
            if (event.data.origin !== "${s}") return;
            if (!event.data.method?.startsWith("proxy-window:")) return;
            const method = event.data.method.replace("proxy-window:", "");
            if (method === "closed" && event.data.windowId === await this.id()) this.closed = true;
          });
        } 

        async id() {
          return await this.windowIdPromise;
        }

        async focus() {
          await window.selector.call("panel.focus", { windowId: await this.id() });
        }

        async postMessage(data) {
          window.selector.call("panel.postMessage", { windowId: await this.id(), data });
        }

        async close() {
          await window.selector.call("panel.close", { windowId: await this.id() });
        }
      }

      window.selector = {
        wallet: null,
        location: "${window.location.href}",
        nearConnectVersion: "${ft.NEAR_CONNECT_VERSION}",
        
        outerHeight: ${window.outerHeight},
        screenY: ${window.screenY},
        outerWidth: ${window.outerWidth},
        screenX: ${window.screenX},

        providers: {
          mainnet: ${JSON.stringify(t.mainnet)},
          testnet: ${JSON.stringify(t.testnet)},
        },

        uuid() {
          return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          });
        },

        walletConnect: {
          connect(params) {
            return window.selector.call("walletConnect.connect", params);
          },
          disconnect(params) {
            return window.selector.call("walletConnect.disconnect", params);
          },
          request(params) {
            return window.selector.call("walletConnect.request", params);
          },
          getProjectId() {
            return window.selector.call("walletConnect.getProjectId", {});
          },
          getSession() {
            return window.selector.call("walletConnect.getSession", {});
          },
        },
      
        async ready(wallet) {
          wallet.manifest = ${JSON.stringify(n)};
          window.parent.postMessage({ method: "wallet-ready", origin: "${s}" }, "*");
          window.selector.wallet = wallet;
        },

        async call(method, params) {
          const id = window.selector.uuid();
          window.parent.postMessage({ method, params, id, origin: "${s}" }, "*");

          return new Promise((resolve, reject) => {
            const handler = (event) => {
              if (event.data.id !== id || event.data.origin !== "${s}") return;
              window.removeEventListener("message", handler);

              if (event.data.status === "failed") reject(event.data.result);
              else resolve(event.data.result);
            };

            window.addEventListener("message", handler);
          });
        },

        panelClosed(windowId) {
          window.parent.postMessage({ 
            method: "panel.closed", 
            origin: "${s}", 
            result: { windowId } 
          }, "*");
        },

        open(url, _, params) {
          return new ProxyWindow(url, params)
        },

        external(entity, key, ...args) {
          return window.selector.call("external", { entity, key, args: args || [] });
        },

        openNativeApp(url) {
          return window.selector.call("open.nativeApp", { url });
        },

        ui: {
          async whenApprove(options) {
            window.selector.ui.showIframe();
            await showPrompt(options);
            window.selector.ui.hideIframe();
          },

          async showIframe() {
            return await window.selector.call("ui.showIframe");
          },

          async hideIframe() {
            return await window.selector.call("ui.hideIframe");
          },
        },

        storage: {
          async set(key, value) {
            await window.selector.call("storage.set", { key, value });
          },
      
          async get(key) {
            return await window.selector.call("storage.get", { key });
          },
      
          async remove(key) {
            await window.selector.call("storage.remove", { key });
          },

          async keys() {
            return await window.selector.call("storage.keys", {});
          },
        },
      };

      // Clipboard API often rejects inside the sandbox (Android WebView), copy through the dApp page then.
      // Plain assignment to navigator.clipboard is a no-op (getter on the prototype), so redefine the method
      const clipboard = navigator.clipboard || {};
      const nativeWriteText = clipboard.writeText ? clipboard.writeText.bind(clipboard) : null;
      Object.defineProperty(clipboard, "writeText", {
        configurable: true,
        value: async (text) => {
          try {
            if (nativeWriteText) return await nativeWriteText(text);
          } catch {}
          await window.selector.call("clipboard.writeText", { text });
        },
      });
      if (!navigator.clipboard) Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

      window.addEventListener("message", async (event) => {
        if (event.data.origin !== "${s}") return;
        if (!event.data.method?.startsWith("wallet:")) return;
      
        const wallet = window.selector.wallet;
        const method = event.data.method.replace("wallet:", "");
        const payload = { id: event.data.id, origin: "${s}", method };
      
        if (wallet == null || typeof wallet[method] !== "function") {
          const data = { ...payload, status: "failed", result: "Method not found" };
          window.parent.postMessage(data, "*");
          return;
        }
        
        try {
          const result = await wallet[method](event.data.params);
          window.parent.postMessage({ ...payload, status: "success", result }, "*");
        } catch (error) {
          const data = { ...payload, status: "failed", result: error };
          window.parent.postMessage(data, "*");
        }
      });
      <\/script>

      <script type="module"${a}>${o}<\/script>
    </body>
  </html>
    `}re.default=pt});var $e=d(k=>{"use strict";var mt=k&&k.__importDefault||function(r){return r&&r.__esModule?r:{default:r}};Object.defineProperty(k,"__esModule",{value:!0});var yt=Z(),bt=_(),xt=Ie(),vt=mt(Ee()),oe=class{constructor(e,t,n,s){i(this,"executor");i(this,"origin");i(this,"disposed",!1);i(this,"iframe",document.createElement("iframe"));i(this,"events",new yt.EventEmitter);i(this,"popup");i(this,"handler");i(this,"readyPromiseResolve");i(this,"readyPromise",new Promise(e=>{this.readyPromiseResolve=e}));this.executor=e,this.origin=(0,bt.uuid4)(),this.handler=a=>{a.data.origin===this.origin&&(a.data.method==="wallet-ready"&&this.readyPromiseResolve(),n(this,a))},window.addEventListener("message",this.handler);let o=[];this.executor.checkPermissions("usb")&&o.push("usb *;"),this.executor.checkPermissions("hid")&&o.push("hid *;"),this.executor.checkPermissions("clipboardRead")&&o.push("clipboard-read;"),this.executor.checkPermissions("clipboardWrite")&&o.push("clipboard-write;"),this.executor.checkPermissions("bluetooth")&&o.push("bluetooth *;"),this.iframe.allow=o.join(" "),this.iframe.setAttribute("sandbox","allow-scripts"),(0,vt.default)({id:this.origin,executor:this.executor,code:t,cspNonce:s}).then(a=>{this.executor.connector.logger?.log("Iframe code injected"),this.iframe.srcdoc=a}),this.popup=new xt.IframeWalletPopup({footer:this.executor.connector.footerBranding,iframe:this.iframe,onApprove:()=>{},onReject:()=>{this.disposed=!0,window.removeEventListener("message",this.handler),this.events.emit("close",{}),this.popup.destroy()}}),this.popup.create()}on(e,t){this.events.on(e,t)}show(){this.popup.show()}hide(){this.popup.hide()}postMessage(e){if(this.disposed)return;let t=this.iframe.contentWindow;if(!t)throw new Error(`Iframe not loaded for ${e?.method??"unknown method"}`);t.postMessage({...e,origin:this.origin},"*")}dispose(){this.disposed=!0,window.removeEventListener("message",this.handler),this.popup.destroy()}};k.default=oe});var Ne=d(A=>{"use strict";var kt=A&&A.__importDefault||function(r){return r&&r.__esModule?r:{default:r}};Object.defineProperty(A,"__esModule",{value:!0});var g=V(),ie=_(),At=ke(),ae=Se(),St=kt($e()),Ct=(0,ie.uuid4)(),le=class{constructor(e,t){i(this,"connector");i(this,"manifest");i(this,"activePanels",{});i(this,"storageSpace");i(this,"_onMessage",async(e,t)=>{let n=o=>{e.postMessage({...t.data,status:"success",result:o})},s=o=>{e.postMessage({...t.data,status:"failed",result:o})};if(t.data.method==="ui.showIframe"){e.show(),n(null);return}if(t.data.method==="ui.hideIframe"){e.hide(),n(null);return}if(t.data.method==="storage.set"){this.assertPermissions(e,"storage",t),localStorage.setItem(`${this.storageSpace}:${t.data.params.key}`,t.data.params.value),n(null);return}if(t.data.method==="storage.get"){this.assertPermissions(e,"storage",t);let o=localStorage.getItem(`${this.storageSpace}:${t.data.params.key}`);n(o);return}if(t.data.method==="storage.keys"){this.assertPermissions(e,"storage",t);let o=Object.keys(localStorage).filter(a=>a.startsWith(`${this.storageSpace}:`));n(o);return}if(t.data.method==="storage.remove"){this.assertPermissions(e,"storage",t),localStorage.removeItem(`${this.storageSpace}:${t.data.params.key}`),n(null);return}if(t.data.method==="panel.focus"){let o=this.activePanels[t.data.params.windowId];o&&o.focus(),n(null);return}if(t.data.method==="panel.postMessage"){let o=this.activePanels[t.data.params.windowId];o&&o.postMessage(t.data.params.data,"*"),n(null);return}if(t.data.method==="panel.close"){let o=this.activePanels[t.data.params.windowId];o&&o.close(),delete this.activePanels[t.data.params.windowId],n(null);return}if(t.data.method==="walletConnect.connect"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).connect(t.data.params);a.approval(),n({uri:a.uri})}catch(o){s(o)}return}if(t.data.method==="walletConnect.getProjectId"){if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");this.assertPermissions(e,"walletConnect",t);let o=await this.connector.walletConnect;n(o.core.projectId);return}if(t.data.method==="walletConnect.disconnect"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).disconnect(t.data.params);n(a)}catch(o){s(o)}return}if(t.data.method==="walletConnect.getSession"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let o=await this.connector.walletConnect,a=o.session.keys[o.session.keys.length-1],l=a?o.session.get(a):null;n(l?{topic:l.topic,namespaces:l.namespaces}:null)}catch(o){s(o)}return}if(t.data.method==="walletConnect.request"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).request(t.data.params);n(a)}catch(o){s(o)}return}if(t.data.method==="clipboard.writeText"){this.assertPermissions(e,"clipboardWrite",t);try{await(0,At.copyText)(t.data.params.text),n(null)}catch(o){s(o)}return}if(t.data.method==="external"){this.assertPermissions(e,"external",t);try{let{entity:o,key:a,args:l}=t.data.params,c=o.split(".").reduce((p,qe)=>p[qe],window);o==="nightly.near"&&a==="signTransaction"&&(l[0].encode=()=>l[0]);let u=typeof c[a]=="function"?await c[a](...l||[]):c[a];n(u)}catch(o){s(o)}return}if(t.data.method==="open"){this.assertPermissions(e,"allowsOpen",t);let o=(0,g.parseUrl)(t.data.params.url);if(o&&o.protocol==="https:"&&(0,ae.isTelegramMiniApp)()){o.hostname==="t.me"?(0,ae.openTelegramLink)(o):(0,ae.openExternalLink)(o),n(null);return}let a=window.open(t.data.params.url,"_blank",t.data.params.features),l=a?(0,ie.uuid4)():null,c=u=>{let p=(0,g.parseUrl)(t.data.params.url);p&&p.origin===u.origin&&e.postMessage(u.data)};if(n(l),window.addEventListener("message",c),a&&l){this.activePanels[l]=a;let u=setInterval(()=>{if(!a?.closed)return;window.removeEventListener("message",c);let p={method:"proxy-window:closed",windowId:l};delete this.activePanels[l],clearInterval(u);try{e.postMessage(p)}catch{}},500)}return}if(t.data.method==="open.nativeApp"){this.assertPermissions(e,"allowsOpen",t);let o=(0,g.parseUrl)(t.data.params.url);if(!o||["https","http","javascript:","file:","data:","blob:","about:"].includes(o.protocol))throw s("Invalid URL"),new Error("[open.nativeApp] Invalid URL");let l=document.createElement("iframe");l.src=t.data.params.url,l.style.display="none",document.body.appendChild(l),e.postMessage({...t.data,status:"success",result:null});return}});i(this,"actualCode",null);this.connector=e,this.manifest=t,this.storageSpace=t.id}checkPermissions(e,t){if(e==="walletConnect")return!!this.manifest.permissions.walletConnect;if(e==="external"){let n=this.manifest.permissions.external;return!n||!t?.entity?!1:n.includes(t.entity)}if(e==="allowsOpen"){let n=(0,g.parseUrl)(t?.url||""),s=this.manifest.permissions.allowsOpen;return!n||!s||!Array.isArray(s)||s.length===0?!1:s.some(a=>{let l=(0,g.parseUrl)(a);return!(!l||n.protocol!==l.protocol||l.hostname&&n.hostname!==l.hostname||l.pathname&&l.pathname!=="/"&&n.pathname!==l.pathname)})}return this.manifest.permissions[e]}assertPermissions(e,t,n){if(!this.checkPermissions(t,n.data.params))throw e.postMessage({...n.data,status:"failed",result:"Permission denied"}),new Error("Permission denied")}async checkNewVersion(e,t){if(this.actualCode)return this.connector.logger?.log("New version of code already checked"),this.actualCode;let n=(0,g.parseUrl)(e.manifest.executor);if(n||(n=(0,g.parseUrl)(location.origin+e.manifest.executor)),!n)throw new Error("Invalid executor URL");n.searchParams.set("nonce",Ct);let s=await fetch(n.toString()).then(o=>{if(!o.ok)throw new Error(`Failed to load executor: ${o.status}`);return o.text()});return this.connector.logger?.log("New version of code fetched"),this.actualCode=s,s===t?(this.connector.logger?.log("New version of code is the same as the current version"),this.actualCode):(await this.connector.db.setItem(`${this.manifest.id}:${this.manifest.version}`,s).then(()=>this.connector.logger?.log("New version of code saved to cache")).catch(o=>this.connector.logger?.log("Failed to cache new version of code",o)),s)}async loadCode(){let e=await this.connector.db.getItem(`${this.manifest.id}:${this.manifest.version}`).catch(()=>null);this.connector.logger?.log("Code loaded from cache",e!==null);let t=this.checkNewVersion(this,e);return e||await t}async call(e,t){this.connector.logger?.log("Add to queue",e,t),this.connector.logger?.log("Calling method",e,t);let n=await this.loadCode();this.connector.logger?.log("Code loaded, preparing");let s=new St.default(this,n,this._onMessage,this.connector.cspNonce);this.connector.logger?.log("Code loaded, iframe initialized"),await s.readyPromise,this.connector.logger?.log("Iframe ready");let o=(0,ie.uuid4)();return new Promise((a,l)=>{try{let c=u=>{u.data.id!==o||u.data.origin!==s.origin||(s.dispose(),window.removeEventListener("message",c),this.connector.logger?.log("postMessage",{result:u.data,request:{method:e,params:t}}),u.data.status==="failed"?l(u.data.result):a(u.data.result))};window.addEventListener("message",c),s.postMessage({method:e,params:t,id:o}),s.on("close",()=>l(new Error("Wallet closed")))}catch(c){this.connector.logger?.log("Iframe error",c),l(c)}})}async getAllStorage(){let e=Object.keys(localStorage).filter(n=>n.startsWith(`${this.storageSpace}:`)),t={};for(let n of e)t[n.replace(`${this.storageSpace}:`,"")]=localStorage.getItem(n);return t}async clearStorage(){let e=Object.keys(localStorage).filter(t=>t.startsWith(`${this.storageSpace}:`));for(let t of e)localStorage.removeItem(t)}};A.default=le});var ue=d(f=>{"use strict";var Pt=f&&f.__importDefault||function(r){return r&&r.__esModule?r:{default:r}};Object.defineProperty(f,"__esModule",{value:!0});f.SandboxWallet=void 0;var ce=x(),de=v(),_t=Pt(Ne()),K=class{constructor(e,t){i(this,"connector");i(this,"manifest");i(this,"executor");this.connector=e,this.manifest=t,this.executor=new _t.default(e,t)}async signIn(e){return this.executor.call("wallet:signIn",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey})}async signInAndSignMessage(e){return this.executor.call("wallet:signInAndSignMessage",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey,messageParams:e.messageParams})}async signOut(e){let t={...e,network:e?.network??this.connector.network};await this.executor.call("wallet:signOut",t),await this.executor.clearStorage()}async getAccounts(e){let t={...e,network:e?.network??this.connector.network};return this.executor.call("wallet:getAccounts",t)}async signAndSendTransaction(e){let t=(0,ce.nearActionsToConnectorActions)(e.actions);(0,de.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let n={...e,actions:t,network:e.network??this.connector.network};return this.executor.call("wallet:signAndSendTransaction",n)}async signAndSendTransactions(e){let t=e.transactions.map(s=>({actions:(0,ce.nearActionsToConnectorActions)(s.actions),receiverId:s.receiverId}));(0,de.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(s=>s.actions),this.manifest.name);let n={...e,transactions:t,network:e.network??this.connector.network};return this.executor.call("wallet:signAndSendTransactions",n)}async signMessage(e){let t={...e,network:e.network??this.connector.network};return this.executor.call("wallet:signMessage",t)}async signDelegateActions(e){let t={...e,delegateActions:e.delegateActions.map(n=>({...n,actions:(0,ce.nearActionsToConnectorActions)(n.actions)})),network:e.network??this.connector.network};return(0,de.assertGasKeyActionsSupported)(this.manifest.features,t.delegateActions.flatMap(n=>n.actions),this.manifest.name),this.executor.call("wallet:signDelegateActions",t)}};f.SandboxWallet=K;f.default=K});var fe=d(q=>{"use strict";Object.defineProperty(q,"__esModule",{value:!0});q.InjectedWallet=void 0;var he=x(),we=v(),ge=class{constructor(e,t){i(this,"connector");i(this,"wallet");this.connector=e,this.wallet=t}get manifest(){return this.wallet.manifest}async signIn({addFunctionCallKey:e,network:t}){return this.wallet.signIn({network:t??this.connector.network,addFunctionCallKey:e})}async signInAndSignMessage(e){return this.wallet.signInAndSignMessage({network:e?.network??this.connector.network,addFunctionCallKey:e.addFunctionCallKey,messageParams:e.messageParams})}async signOut(e){await this.wallet.signOut({network:e?.network??this.connector.network})}async getAccounts(e){return this.wallet.getAccounts({network:e?.network??this.connector.network})}async signAndSendTransaction(e){let t=(0,he.nearActionsToConnectorActions)(e.actions);(0,we.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let n=e.network??this.connector.network,s=await this.wallet.signAndSendTransaction({...e,actions:t,network:n});if(!s)throw new Error("No result from wallet");return Array.isArray(s.transactions)?s.transactions[0]:s}async signAndSendTransactions(e){let t=e.network??this.connector.network,n=e.transactions.map(o=>({actions:(0,he.nearActionsToConnectorActions)(o.actions),receiverId:o.receiverId}));(0,we.assertGasKeyActionsSupported)(this.manifest.features,n.flatMap(o=>o.actions),this.manifest.name);let s=await this.wallet.signAndSendTransactions({...e,transactions:n,network:t});if(!s)throw new Error("No result from wallet");return Array.isArray(s.transactions)?s.transactions:s}async signMessage(e){return this.wallet.signMessage({...e,network:e.network??this.connector.network})}async signDelegateActions(e){let t=e.delegateActions.map(n=>({...n,actions:(0,he.nearActionsToConnectorActions)(n.actions)}));return(0,we.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(n=>n.actions),this.manifest.name),this.wallet.signDelegateActions({...e,delegateActions:t,network:e.network??this.connector.network})}};q.InjectedWallet=ge});var We=d(D=>{"use strict";Object.defineProperty(D,"__esModule",{value:!0});D.NearWalletsPopup=void 0;var y=W(),It=V(),Mt=te(),Et={id:"custom-wallet",name:"Custom Wallet",icon:"https://www.mynearwallet.com/images/webclip.png",description:"Custom wallet for NEAR.",website:"",version:"1.0.0",executor:"your-executor-url.js",type:"sandbox",platform:{},features:{signMessage:!0,signInWithoutAddKey:!0,signInAndSignMessage:!0,signAndSendTransaction:!0,signAndSendTransactions:!0,signDelegateActions:!0},permissions:{storage:!0,allowsOpen:[]}},pe=class extends Mt.Popup{constructor(t){super(t);i(this,"delegate");this.delegate=t,this.update({wallets:t.wallets,showSettings:!1})}handlers(){super.handlers(),this.addListener(".settings-button","click",()=>this.update({showSettings:!0})),this.addListener(".back-button","click",()=>this.update({showSettings:!1})),this.root.querySelectorAll(".connect-item").forEach(t=>{t instanceof HTMLDivElement&&this.addListener(t,"click",()=>this.delegate.onSelect(t.dataset.type))}),this.root.querySelectorAll(".remove-wallet-button").forEach(t=>{t instanceof SVGSVGElement&&this.addListener(t,"click",async n=>{n.stopPropagation(),await this.delegate.onRemoveDebugManifest(t.dataset.type);let s=this.state.wallets.filter(o=>o.id!==t.dataset.type);this.update({wallets:s})})}),this.addListener(".add-debug-manifest-button","click",async()=>{try{let t=this.root.querySelector("#debug-manifest-input")?.value??"",n=await this.delegate.onAddDebugManifest(t);this.update({showSettings:!1,wallets:[n,...this.state.wallets]})}catch(t){alert(`Something went wrong: ${t}`)}})}create(){super.create({show:!0})}walletDom(t){let n=(0,y.html)`
      <svg
        class="remove-wallet-button"
        data-type="${t.id}"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style="margin-right: 4px;"
      >
        <path d="M18 6L6 18" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M6 6L18 18" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `;return(0,y.html)`
      <div class="connect-item" data-type="${t.id}">
        <img style="background: #333" src="${t.icon}" alt="${t.name}" />
        <div class="connect-item-info">
          <span>${t.name}</span>
          <span class="wallet-address">${(0,It.parseUrl)(t.website)?.hostname}</span>
        </div>
        ${t.debug?n:""}
      </div>
    `}get footer(){if(!this.delegate.footer)return"";let{icon:t,heading:n,link:s,linkText:o}=this.delegate.footer;return(0,y.html)`
      <div class="footer">
        ${t?(0,y.html)`<img src="${t}" alt="${n}" />`:""}
        <p>${n}</p>
        <a class="get-wallet-link" href="${s}" target="_blank">${o}</a>
      </div>
    `}get dom(){return this.state.showSettings?(0,y.html)`
        <div class="modal-container">
          <div class="modal-content">
            <div class="modal-header">
              <button class="back-button" style="left: 16px; right: unset;">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M15 18L9 12L15 6" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <p>Settings</p>
            </div>

            <div class="modal-body">
              <p style="text-align: left;">
                You can add your wallet to dapp for debug,
                <a href="https://github.com/azbang/hot-connector" target="_blank">read the documentation.</a> Paste your manifest and click "Add".
              </p>

              <textarea style="width: 100%;" id="debug-manifest-input" rows="10">${JSON.stringify(Et,null,2)}</textarea>
              <button class="add-debug-manifest-button">Add</button>
            </div>

            ${this.footer}
          </div>
        </div>
      `:(0,y.html)`<div class="modal-container">
      <div class="modal-content">
        <div class="modal-header">
          <p>Select wallet</p>
          <button class="settings-button">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="2" fill="rgba(255,255,255,0.5)" />
              <circle cx="19" cy="12" r="2" fill="rgba(255,255,255,0.5)" />
              <circle cx="5" cy="12" r="2" fill="rgba(255,255,255,0.5)" />
            </svg>
          </button>
        </div>

        <div class="modal-body">${this.state.wallets.map(t=>this.walletDom(t))}</div>

        ${this.footer}
      </div>
    </div>`}};D.NearWalletsPopup=pe});var je=d(ye=>{"use strict";Object.defineProperty(ye,"__esModule",{value:!0});var me=class{constructor(e,t){i(this,"dbName");i(this,"storeName");i(this,"version");this.dbName=e,this.storeName=t,this.version=1}getDb(){return new Promise((e,t)=>{if(typeof window>"u"||typeof indexedDB>"u"){t(new Error("IndexedDB is not available (SSR environment)"));return}let n=indexedDB.open(this.dbName,this.version);n.onerror=s=>{console.error("Error opening database:",s.target.error),t(new Error("Error opening database"))},n.onsuccess=s=>{e(n.result)},n.onupgradeneeded=s=>{let o=n.result;o.objectStoreNames.contains(this.storeName)||o.createObjectStore(this.storeName)}})}async getItem(e){let t=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((n,s)=>{if(!this.storeName){s(new Error("Store name not set"));return}let o=t.transaction(this.storeName,"readonly");o.onerror=c=>s(o.error);let l=o.objectStore(this.storeName).get(e);l.onerror=c=>s(l.error),l.onsuccess=()=>{n(l.result),t.close()}})}async setItem(e,t){let n=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((s,o)=>{if(!this.storeName){o(new Error("Store name not set"));return}let a=n.transaction(this.storeName,"readwrite");a.onerror=u=>o(a.error);let c=a.objectStore(this.storeName).put(t,e);c.onerror=u=>o(c.error),c.onsuccess=()=>{n.close(),s()}})}async removeItem(e){let t=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((n,s)=>{if(!this.storeName){s(new Error("Store name not set"));return}let o=t.transaction(this.storeName,"readwrite");o.onerror=c=>s(o.error);let l=o.objectStore(this.storeName).delete(e);l.onerror=c=>s(l.error),l.onsuccess=()=>{t.close(),n()}})}async keys(){let e=await this.getDb();return new Promise((t,n)=>{if(!this.storeName){n(new Error("Store name not set"));return}let s=e.transaction(this.storeName,"readonly");s.onerror=l=>n(s.error);let a=s.objectStore(this.storeName).getAllKeys();a.onerror=l=>n(a.error),a.onsuccess=()=>{t(a.result),e.close()}})}async count(){let e=await this.getDb();return new Promise((t,n)=>{if(!this.storeName){n(new Error("Store name not set"));return}let s=e.transaction(this.storeName,"readonly");s.onerror=l=>n(s.error);let a=s.objectStore(this.storeName).count();a.onerror=l=>n(a.error),a.onsuccess=()=>{t(a.result),e.close()}})}async length(){return this.count()}async clear(){let e=await this.getDb();return new Promise((t,n)=>{if(!this.storeName){n(new Error("Store name not set"));return}let s=e.transaction(this.storeName,"readwrite");s.onerror=l=>n(s.error);let a=s.objectStore(this.storeName).clear();a.onerror=l=>n(a.error),a.onsuccess=()=>{e.close(),t()}})}};ye.default=me});var Te=d(b=>{"use strict";var $t=b&&b.__importDefault||function(r){return r&&r.__esModule?r:{default:r}};Object.defineProperty(b,"__esModule",{value:!0});b.NearConnector=void 0;var Nt=Z(),Wt=We(),jt=U(),Ot=$t(je()),Tt=J(),Lt=fe(),Oe=ue(),Kt=["https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json","https://cdn.jsdelivr.net/gh/azbang/hot-connector/repository/manifest.json"];function qt(r){return e=>Object.entries(r).length===0?!0:Object.entries(r).filter(([t,n])=>n===!0).every(([t])=>e.manifest.features?.[t]===!0)}var be=class{constructor(e){i(this,"storage");i(this,"events");i(this,"db");i(this,"logger");i(this,"wallets",[]);i(this,"manifest",{wallets:[],version:"1.0.0"});i(this,"features",{});i(this,"network","mainnet");i(this,"providers",{mainnet:[],testnet:[]});i(this,"walletConnect");i(this,"footerBranding");i(this,"excludedWallets",[]);i(this,"autoConnect");i(this,"cspNonce");i(this,"whenManifestLoaded");i(this,"_handleNearWalletInjected",e=>{this.wallets=this.wallets.filter(t=>t.manifest.id!==e.detail.manifest.id),this.wallets.unshift(new Lt.InjectedWallet(this,e.detail)),this.events.emit("selector:walletsChanged",{})});this.db=new Ot.default("hot-connector","wallets"),this.storage=e?.storage??new jt.LocalStorage,this.events=e?.events??new Nt.EventEmitter,this.logger=e?.logger,this.cspNonce=e?.cspNonce,this.network=e?.network??"mainnet",this.walletConnect=e?.walletConnect,this.autoConnect=e?.autoConnect??!0,this.providers=e?.providers??{mainnet:[],testnet:[]},this.excludedWallets=e?.excludedWallets??[],this.features=e?.features??{},e?.footerBranding!==void 0?this.footerBranding=e?.footerBranding:this.footerBranding={icon:"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%20512%20512%22%20class%3D%22size-7%22%3E%3Crect%20width%3D%22512%22%20height%3D%22512%22%20fill%3D%22%2300ec97%22%20rx%3D%22110%22%2F%3E%3Cpath%20fill%3D%22%23000%22%20d%3D%22M373.89%20106.199a31.95%2031.95%200%200%200-27.213%2015.207l-62.631%2092.979a6.67%206.67%200%200%200-.989%205.001%206.66%206.66%200%200%200%202.837%204.235%206.67%206.67%200%200%200%208.032-.494l61.643-53.47c1.02-.924%202.599-.827%203.523.193.419.473.644%201.074.644%201.697v167.402a2.49%202.49%200%200%201-2.502%202.491%202.48%202.48%200%200%201-1.912-.891L168.976%20117.497a31.93%2031.93%200%200%200-24.356-11.298h-6.508c-17.623%200-31.917%2014.294-31.917%2031.917v235.767c0%2017.623%2014.294%2031.917%2031.917%2031.917a31.94%2031.94%200%200%200%2027.213-15.206l62.631-92.98a6.66%206.66%200%200%200-1.847-9.236%206.67%206.67%200%200%200-8.033.494l-61.643%2053.471c-1.02.923-2.599.826-3.522-.194a2.5%202.5%200%200%201-.634-1.697V173.008a2.49%202.49%200%200%201%202.502-2.492c.731%200%201.439.322%201.912.891l186.313%20223.096a31.95%2031.95%200%200%200%2024.357%2011.297h6.508c17.623%200%2031.927-14.272%2031.938-31.895V138.116c0-17.623-14.294-31.917-31.917-31.917%22%2F%3E%3C%2Fsvg%3E",heading:"NEAR Connector",link:"https://wallet.near.org",linkText:"Don't have a wallet?"},this.whenManifestLoaded=new Promise(async t=>{e?.manifest==null||typeof e.manifest=="string"?this.manifest=await this._loadManifest(e?.manifest).catch(()=>({wallets:[],version:"1.0.0"})):this.manifest=e?.manifest??{wallets:[],version:"1.0.0"};let n=new Set(this.excludedWallets);n.delete("hot-wallet"),this.manifest.wallets=this.manifest.wallets.filter(s=>!(s.permissions.walletConnect&&!this.walletConnect||n.has(s.id))),await new Promise(s=>setTimeout(s,100)),t()}),typeof window<"u"&&(window.addEventListener("near-wallet-injected",this._handleNearWalletInjected),window.dispatchEvent(new Event("near-selector-ready")),window.addEventListener("message",async t=>{t.data.type==="near-wallet-injected"&&(await this.whenManifestLoaded.catch(()=>{}),this.wallets=this.wallets.filter(n=>n.manifest.id!==t.data.manifest.id),this.wallets.unshift(new Tt.ParentFrameWallet(this,t.data.manifest)),this.events.emit("selector:walletsChanged",{}),this.autoConnect&&this.connect({walletId:t.data.manifest.id}))})),this.whenManifestLoaded.then(()=>{typeof window<"u"&&window.parent.postMessage({type:"near-selector-ready"},"*"),this.manifest.wallets.forEach(t=>this.registerWallet(t)),this.storage.get("debug-wallets").then(t=>{JSON.parse(t??"[]").forEach(s=>this.registerDebugWallet(s))})})}get availableWallets(){return this.wallets.filter(t=>Object.entries(this.features).every(([n,s])=>!(s&&!t.manifest.features?.[n]))).filter(t=>!(this.network==="testnet"&&!t.manifest.features?.testnet))}async _loadManifest(e){let t=e?[e]:Kt;for(let n of t){let s=await fetch(n).catch(()=>null);if(!(!s||!s.ok))return await s.json()}throw new Error("Failed to load manifest")}async switchNetwork(e,t){this.network!==e&&(await this.disconnect().catch(()=>{}),this.network=e,await this.connect(t))}async registerWallet(e){if(e.type!=="sandbox")throw new Error("Only sandbox wallets are supported");this.wallets.find(t=>t.manifest.id===e.id)||(this.wallets.push(new Oe.SandboxWallet(this,e)),this.events.emit("selector:walletsChanged",{}))}async registerDebugWallet(e){let t=typeof e=="string"?JSON.parse(e):e;if(t.type!=="sandbox")throw new Error("Only sandbox wallets type are supported");if(!t.id)throw new Error("Manifest must have an id");if(!t.name)throw new Error("Manifest must have a name");if(!t.icon)throw new Error("Manifest must have an icon");if(!t.website)throw new Error("Manifest must have a website");if(!t.version)throw new Error("Manifest must have a version");if(!t.executor)throw new Error("Manifest must have an executor");if(!t.features)throw new Error("Manifest must have features");if(!t.permissions)throw new Error("Manifest must have permissions");if(this.wallets.find(s=>s.manifest.id===t.id))throw new Error("Wallet already registered");t.debug=!0,this.wallets.unshift(new Oe.SandboxWallet(this,t)),this.events.emit("selector:walletsChanged",{});let n=this.wallets.filter(s=>s.manifest.debug).map(s=>s.manifest);return this.storage.set("debug-wallets",JSON.stringify(n)),t}async removeDebugWallet(e){this.wallets=this.wallets.filter(n=>n.manifest.id!==e);let t=this.wallets.filter(n=>n.manifest.debug).map(n=>n.manifest);this.storage.set("debug-wallets",JSON.stringify(t)),this.events.emit("selector:walletsChanged",{})}async selectWallet({features:e={}}={}){return await this.whenManifestLoaded.catch(()=>{}),new Promise((t,n)=>{let s=new Wt.NearWalletsPopup({footer:this.footerBranding,wallets:this.availableWallets.filter(qt(e)).map(o=>o.manifest),onRemoveDebugManifest:async o=>this.removeDebugWallet(o),onAddDebugManifest:async o=>this.registerDebugWallet(o),onReject:()=>(n(new Error("User rejected")),s.destroy()),onSelect:o=>(t(o),s.destroy())});s.create()})}async connect(e={}){let t=e.walletId,n=e.signMessageParams;await this.whenManifestLoaded.catch(()=>{}),t||(t=await this.selectWallet({features:{signInAndSignMessage:e.signMessageParams!=null?!0:void 0,signInWithFunctionCallKey:e.addFunctionCallKey!=null?!0:void 0}}));try{let s=await this.wallet(t);this.logger?.log("Wallet available to connect",s),await this.storage.set("selected-wallet",t),this.logger?.log(`Set preferred wallet, try to signIn${n!=null?" (with signed message)":""}`,t);let o;if(e.addFunctionCallKey!=null&&(this.logger?.log("Adding function call access key during sign in with params",e.addFunctionCallKey),o={...e.addFunctionCallKey,gasAllowance:e.addFunctionCallKey.gasAllowance??{amount:"250000000000000000000000",kind:"limited"}}),n!=null){let a=await s.signInAndSignMessage({addFunctionCallKey:o,messageParams:n,network:this.network});if(!a?.length)throw new Error("Failed to sign in");this.logger?.log("Signed in to wallet (with signed message)",t,a),this.events.emit("wallet:signInAndSignMessage",{wallet:s,accounts:a,success:!0}),this.events.emit("wallet:signIn",{wallet:s,accounts:a.map(l=>({accountId:l.accountId,publicKey:l.publicKey})),success:!0,source:"signInAndSignMessage"})}else{let a=await s.signIn({addFunctionCallKey:o,network:this.network});if(!a?.length)throw new Error("Failed to sign in");this.logger?.log("Signed in to wallet",t,a),this.events.emit("wallet:signIn",{wallet:s,accounts:a,success:!0,source:"signIn"})}return s}catch(s){throw this.logger?.log("Failed to connect to wallet",s),s}}async disconnect(e){e||(e=await this.wallet()),await e.signOut({network:this.network}),await this.storage.remove("selected-wallet"),this.events.emit("wallet:signOut",{success:!0})}async getConnectedWallet(){await this.whenManifestLoaded.catch(()=>{});let e=await this.storage.get("selected-wallet"),t=this.wallets.find(s=>s.manifest.id===e);if(!t)throw new Error("No wallet selected");let n=await t.getAccounts();if(!n?.length)throw new Error("No accounts found");return{wallet:t,accounts:n}}async wallet(e){if(await this.whenManifestLoaded.catch(()=>{}),!e)return this.getConnectedWallet().then(({wallet:n})=>n).catch(async()=>{throw await this.storage.remove("selected-wallet"),new Error("No accounts found")});let t=this.wallets.find(n=>n.manifest.id===e);if(!t)throw new Error("Wallet not found");return t}async use(e){await this.whenManifestLoaded.catch(()=>{}),this.wallets=this.wallets.map(t=>new Proxy(t,{get(n,s,o){let a=Reflect.get(n,s,o);if(s in e&&typeof a=="function"){let l=e[s];return function(...c){let u=()=>a.apply(n,c);return c.length>0?l.call(this,...c,u):l.call(this,void 0,u)}}return a}}))}on(e,t){this.events.on(e,t)}once(e,t){this.events.once(e,t)}off(e,t){this.events.off(e,t)}removeAllListeners(e){this.events.removeAllListeners(e)}};b.NearConnector=be});var Ke=d(h=>{"use strict";Object.defineProperty(h,"__esModule",{value:!0});h.assertGasKeyActionsSupported=h.isGasKeyAction=h.nearActionsToConnectorActions=h.NearConnector=h.InjectedWallet=h.SandboxWallet=h.ParentFrameWallet=h.LocalStorage=void 0;var Dt=U();Object.defineProperty(h,"LocalStorage",{enumerable:!0,get:function(){return Dt.LocalStorage}});var Ft=J();Object.defineProperty(h,"ParentFrameWallet",{enumerable:!0,get:function(){return Ft.ParentFrameWallet}});var Gt=ue();Object.defineProperty(h,"SandboxWallet",{enumerable:!0,get:function(){return Gt.SandboxWallet}});var Ut=fe();Object.defineProperty(h,"InjectedWallet",{enumerable:!0,get:function(){return Ut.InjectedWallet}});var Rt=Te();Object.defineProperty(h,"NearConnector",{enumerable:!0,get:function(){return Rt.NearConnector}});var zt=x();Object.defineProperty(h,"nearActionsToConnectorActions",{enumerable:!0,get:function(){return zt.nearActionsToConnectorActions}});var Le=v();Object.defineProperty(h,"isGasKeyAction",{enumerable:!0,get:function(){return Le.isGasKeyAction}});Object.defineProperty(h,"assertGasKeyActionsSupported",{enumerable:!0,get:function(){return Le.assertGasKeyActionsSupported}})});var Bt=He(Ke(),1);var export_NearConnector=Bt.NearConnector;export{export_NearConnector as NearConnector};
