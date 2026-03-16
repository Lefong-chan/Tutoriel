import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DB_URL
  });
}

const db = admin.database();

const rows = ['A','B','C','D','E'];
const cols = ['1','2','3','4','5','6','7','8','9'];

const allowedMoves = {
'A1':['A2','B1','B2'],'A2':['A1','A3','B2'],'A3':['A2','A4','B2','B3','B4'],
'A4':['A3','A5','B4'],'A5':['A4','A6','B4','B5','B6'],'A6':['A5','A7','B6'],
'A7':['A6','A8','B6','B7','B8'],'A8':['A7','A9','B8'],'A9':['A8','B8','B9'],
'B1':['A1','B2','C1'],'B2':['A1','A2','A3','B1','B3','C1','C2','C3'],'B3':['A3','B2','B4','C3'],
'B4':['A3','A4','A5','B3','B5','C3','C4','C5'],'B5':['A5','B4','B6','C5'],'B6':['A5','A6','A7','B5','B7','C5','C6','C7'],
'B7':['A7','B6','B8','C7'],'B8':['A7','A8','A9','B7','B9','C7','C8','C9'],'B9':['A9','B8','C9'],
'C1':['B1','B2','C2','D1','D2'],'C2':['B2','C1','C3','D2'],'C3':['B2','B3','B4','C2','C4','D2','D3','D4'],
'C4':['B4','C3','C5','D4'],'C5':['B4','B5','B6','C4','C6','D4','D5','D6'],'C6':['B6','C5','C7','D6'],
'C7':['B6','B7','B8','C6','C8','D6','D7','D8'],'C8':['B8','C7','C9','D8'],'C9':['B8','B9','C8','D8','D9'],
'D1':['C1','D2','E1'],'D2':['C1','C2','C3','D1','D3','E1','E2','E3'],'D3':['C3','D2','D4','E3'],
'D4':['C3','C4','C5','D3','D5','E3','E4','E5'],'D5':['C5','D4','D6','E5'],'D6':['C5','C6','C7','D5','D7','E5','E6','E7'],
'D7':['C7','D6','D8','E7'],'D8':['C7','C8','C9','D7','D9','E7','E8','E9'],'D9':['C9','D8','E9'],
'E1':['D1','D2','E2'],'E2':['D2','E1','E3'],'E3':['D2','D3','D4','E2','E4'],
'E4':['D4','E3','E5'],'E5':['D4','D5','D6','E4','E6'],'E6':['D6','E5','E7'],
'E7':['D6','D7','D8','E6','E8'],'E8':['D8','E7','E9'],'E9':['D8','D9','E8']
};

function createInitialBoard(){

let pieces={}

rows.forEach((r,ri)=>{
cols.forEach((c,ci)=>{

let key=r+c

if(ri<2) pieces[key]="mena"
else if(ri>2) pieces[key]="maintso"
else{

if([1,3,6,8].includes(ci)) pieces[key]="mena"
else if([0,2,5,7].includes(ci)) pieces[key]="maintso"

}

})
})

return pieces

}

function getCaptures(pieces,s,e,color){

const enemy=color==="mena"?"maintso":"mena"

const r1=rows.indexOf(s[0])
const c1=cols.indexOf(s[1])

const r2=rows.indexOf(e[0])
const c2=cols.indexOf(e[1])

const dr=r2-r1
const dc=c2-c1

function scan(row,col,sr,sc){

let res=[]
let cr=row+sr
let cc=col+sc

while(cr>=0 && cr<5 && cc>=0 && cc<9){

let k=rows[cr]+cols[cc]

if(pieces[k]===enemy){
res.push(k)
cr+=sr
cc+=sc
}else break

}

return res

}

return{
approach:scan(r2,c2,dr,dc),
withdrawal:scan(r1,c1,-dr,-dc)
}

}

export default async function handler(req,res){

try{

const {action,gameId,origin,target}=req.body

const gameRef=db.ref("games/"+gameId)

if(action==="init"){

let snap=await gameRef.get()

if(!snap.exists()){

await gameRef.set({
pieces:createInitialBoard(),
turn:"maintso",
movingPiece:"",
visited:[],
lastDir:""
})

}

return res.json({success:true})

}

if(action==="get"){

let snap=await gameRef.get()

return res.json({
success:true,
data:snap.val()
})

}

if(action==="move"){

let snap=await gameRef.get()

let game=snap.val()

if(!game) return res.status(400).json({error:"game not found"})

let pieces={...game.pieces}

if(!pieces[origin]) return res.status(400).json({error:"no piece"})

if(pieces[target]) return res.status(400).json({error:"occupied"})

if(!allowedMoves[origin].includes(target))
return res.status(400).json({error:"illegal move"})

let color=pieces[origin]

if(color!==game.turn)
return res.status(400).json({error:"not your turn"})

let caps=getCaptures(pieces,origin,target,color)

delete pieces[origin]

pieces[target]=color

let captured=[...caps.approach,...caps.withdrawal]

captured.forEach(k=>{
delete pieces[k]
})

await gameRef.update({
pieces:pieces,
turn:color==="mena"?"maintso":"mena",
movingPiece:"",
visited:[],
lastDir:""
})

return res.json({success:true})

}

return res.status(400).json({error:"invalid action"})

}catch(err){

return res.status(500).json({
error:err.message
})

}

}
