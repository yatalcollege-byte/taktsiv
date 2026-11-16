import {firebaseConfig,householdId} from './firebase-config.js';
const $=id=>document.getElementById(id);
const KEY='my_monthly_budget_v1';
const status=(s,msg)=>{$('cloudStatus').textContent=s;if(msg)$('cloudHelp').textContent=msg;};
const valid=x=>x&&x.months&&typeof x.months==='object'&&!Array.isArray(x.months)&&Array.isArray(x.expenses);
const clone=x=>JSON.parse(JSON.stringify(x));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Three-way merge: independent expenses never overwrite one another.
// Simultaneous edits of the same expense/month are rejected, not silently overwritten.
function merge(base,local,remote){
 const out=clone(remote),byId=a=>new Map(a.map(x=>[x.id,x]));
 const b=byId(base.expenses),l=byId(local.expenses),r=byId(remote.expenses);
 for(const id of new Set([...b.keys(),...l.keys()])){
  const before=b.get(id),after=l.get(id),current=r.get(id);
  if(equal(before,after))continue;
  if(!equal(before,current)&&!equal(after,current))throw Error('CONFLICT_EXPENSE');
  if(after===undefined)r.delete(id);else r.set(id,after);
 }
 out.expenses=[...r.values()];
 for(const month of new Set([...Object.keys(base.months),...Object.keys(local.months)])){
  const before=base.months[month],after=local.months[month],current=remote.months[month];
  if(equal(before,after))continue;
  if(!equal(before,current)&&!equal(after,current))throw Error('CONFLICT_MONTH');
  if(after===undefined)delete out.months[month];else out.months[month]=after;
 }
 return out;
}
function freeze(frozen){document.querySelectorAll('main.wrap > section:not(#cloudPanel), main.wrap > header').forEach(el=>{el.style.pointerEvents=frozen?'none':'';el.style.opacity=frozen?'.42':''});}
freeze(true);
try{
 const [{initializeApp},{getAuth,onAuthStateChanged,signInWithEmailAndPassword,signOut},{getFirestore,doc,getDoc,onSnapshot,runTransaction}]=await Promise.all([
  import('https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js'),
  import('https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js'),
  import('https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js')]);
 const app=initializeApp(firebaseConfig),auth=getAuth(app),store=getFirestore(app);
 const householdRef=doc(store,'households',householdId),budgetRef=doc(store,'households',householdId,'data','budget');
 let unsub=null,active=false,busy=false,base=null,queued=null,authUid=null;
 const stop=()=>{if(unsub){unsub();unsub=null}active=false;busy=false;queued=null;base=null;window.budgetCloud=null;freeze(true)};
 const putLocal=x=>{localStorage.setItem(KEY,JSON.stringify(x));};
 async function flush(){if(busy||!active||!queued)return;busy=true;
  while(queued&&active){const target=queued;queued=null;const prior=clone(base);
   try{
    const saved=await runTransaction(store,async tx=>{
     const snap=await tx.get(budgetRef),remote=snap.exists()?snap.data().budget:{months:{},expenses:[]};
     if(!valid(remote))throw Error('INVALID_REMOTE');
     const merged=merge(prior,target,remote);
     tx.set(budgetRef,{budget:merged,updatedAt:new Date().toISOString(),updatedBy:authUid});return merged;
    });
    base=clone(saved);putLocal(saved);status('מסונכרן','השינויים נשמרו בענן.');
   }catch(e){active=false;queued=null;freeze(true);status('שגיאת שמירה','השינוי לא נשמר בענן. יש לייצא גיבוי ולרענן. '+e.message);alert('השמירה בענן נכשלה. אל תמשיכו להזין נתונים. '+e.message);break;}
  }
  busy=false;
 }
 function queueSave(data){if(!active){status('לא מסונכרן','לא ניתן לשמור עד שהחיבור לענן פעיל.');return;}queued=clone(data);flush();}
 async function start(user){stop();authUid=user.uid;window.budgetUserEmail=user.email||'';$('cloudLogin').classList.add('hide');$('cloudConnected').classList.remove('hide');$('cloudAccount').textContent=user.email||'';status('מאמת הרשאות...');
  try{
   const household=await getDoc(householdRef);
   if(!household.exists()||!Array.isArray(household.data().members)||!household.data().members.includes(user.uid))throw Error('החשבון אינו חבר בתקציב המשפחתי. בדקו UID במערך members.');
   const snap=await getDoc(budgetRef);
   let cloud=snap.exists()?snap.data().budget:null;
   if(cloud&&!valid(cloud))throw Error('פורמט הנתונים בענן אינו תקין');
   if(!cloud){
    // Do not upload pre-existing local data automatically. Explicit confirmation required.
    const local=JSON.parse(localStorage.getItem(KEY)||'null');
    const hasData=valid(local)&&(local.expenses.length||Object.values(local.months).some(m=>m.income>0||m.fixed?.some(f=>f.amount>0)));
    const initial=hasData&&confirm('אין תקציב בענן. נמצאו נתונים מקומיים במכשיר הזה. האם להעלות אותם כתקציב המשפחתי? בחרו ביטול להתחלה ריקה.')?local:{months:{},expenses:[]};
    cloud=await runTransaction(store,async tx=>{const d=await tx.get(budgetRef);if(d.exists())return d.data().budget;tx.set(budgetRef,{budget:initial,updatedAt:new Date().toISOString(),updatedBy:user.uid});return initial;});
   }
   base=clone(cloud);putLocal(cloud);
   // Original app keeps an in-memory db; reload once to use authoritative cloud state.
   const bootKey='budget_v3_boot_'+user.uid;
   if(sessionStorage.getItem(bootKey)!==JSON.stringify(cloud)){
    sessionStorage.setItem(bootKey,JSON.stringify(cloud));location.reload();return;
   }
   active=true;window.budgetCloud={queueSave};freeze(false);
   status('מסונכרן','מחוברים לתקציב משפחתי משותף. כל משתמש נכנס בחשבון האישי שלו.');
   unsub=onSnapshot(budgetRef,s=>{
    if(!s.exists()||!active||busy||queued)return;
    const remote=s.data().budget;
    if(!valid(remote)||equal(base,remote))return;
    base=clone(remote);putLocal(remote);
    // Refresh to synchronize all screen calculations with remote updates.
    sessionStorage.setItem(bootKey,JSON.stringify(remote));location.reload();
   },e=>{active=false;freeze(true);status('החיבור נותק',e.message)});
  }catch(e){active=false;freeze(true);status('אין גישה לתקציב',e.message);}
 }
 onAuthStateChanged(auth,user=>{stop();if(user)start(user);else{$('cloudLogin').classList.remove('hide');$('cloudConnected').classList.add('hide');status('נדרשת התחברות','התחברו כל אחד עם הדוא״ל והסיסמה האישיים.');}});
 $('cloudSignIn').onclick=async()=>{try{status('מתחבר...');await signInWithEmailAndPassword(auth,$('cloudEmail').value.trim(),$('cloudPassword').value)}catch(e){status('שגיאת התחברות',e.message)}};
 $('cloudSignUp').classList.add('hide');
 $('cloudSignOut').onclick=async()=>{await signOut(auth);localStorage.removeItem(KEY);location.reload()};
}catch(e){freeze(true);status('שגיאת טעינה','לא ניתן לטעון Firebase: '+e.message)}
