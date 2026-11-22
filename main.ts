import f from'fs'
let w,N,W,M,G,D,F,S,V,Z
F=(s,c)=>{let q=[s],r={[s]:''};M=s;for(let x of q)for(let j=0;j<4;j++){let y=x+D[j];if(!W[y]&&!c.includes(y)&&!(y in r)){y<M&&(M=y);q.push(y);r[y]=r[x]+'ulrd'[j]}}return r}
S=(b,p)=>{
F(p,b)
let Q=[[b,p,'']],I=new Set([b+','+M])
for(let s of Q){
let c=s[0],r=F(s[1],c)
for(let i=0;i<c.length;i++)for(let j=0;j<4;j++){
let x=c[i],d=D[j],t=x+d
if(!(x-d in r)||W[t]||c.includes(t)||(!G.includes(t)&&(W[t-w]||W[t+w])&&(W[t-1]||W[t+1])))continue
let n=c.slice();n[i]=t;n.sort((a,b)=>a-b)
F(x,n)
if(I.has(n+','+M))continue
I.add(n+','+M)
let m=s[2]+r[x-d]+'ulrd'[j]
if(n+''==G+''){Z=x;return m}
Q.push([n,x,m])}}
return''}
V=T=>{
let g=T.replace(/\n/g,'')
w=T.indexOf('\n');N=g.length;D=[-w,-1,1,w]
W=new Uint8Array(N).fill(1)
let pl=0,rm={}
g.replace(/[^#]/g,(c,i)=>{let r=rm[(i%w>6)*2+(i>8*w)]??=[[],[]];W[i]=0;if('.*+'.includes(c))r[1].push(i);if('$*'.includes(c))r[0].push(i);if('@+'.includes(c))pl=i})
let O=W,m=''
rm=Object.values(rm)
for(let ri=0;ri<rm.length;ri++){
W=O.slice()
rm.forEach((r,j)=>{if(j!=ri)for(let x of r[0])W[x]=1})
G=rm[ri][1]
m+=S(rm[ri][0],pl);pl=Z;rm[ri][0]=rm[ri][1]}
return m}
for(let k=1;k<6;k++)f.mkdirSync('/output/i00'+k,{recursive:true}),f.writeFileSync('/output/i00'+k+'/solution.txt',V(f.readFileSync('/input/i00'+k+'/level.txt','utf8')))
