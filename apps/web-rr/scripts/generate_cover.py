#!/usr/bin/env python3
"""No Wave 默认封面生成器：python generate_cover.py --post-id abc123 --size 1200x1500 -o out.jpg
同一个 post-id 永远生成同一张图。依赖：numpy、Pillow。"""
import argparse, hashlib
import numpy as np
from PIL import Image, ImageDraw
PALETTES = {  # 底色在前；w 为各色出现权重；cream 用于画框线(第5色)
 'ember':   (['#D8541F','#0F0D0C','#8B1A10','#E9A98F','#F2EEE6','#B13A12'],[.28,.22,.18,.12,.08,.12]),
 'oxblood': (['#8B1A10','#0F0D0C','#D8541F','#F2EEE6','#E9A98F','#5A0E08'],[.30,.25,.15,.08,.10,.12]),
 'bone':    (['#F2EEE6','#0F0D0C','#D8541F','#E9A98F','#8B1A10','#CFC6B6'],[.30,.20,.20,.10,.08,.12]),
 'night':   (['#0F0D0C','#D8541F','#E9A98F','#8B1A10','#F2EEE6','#2A1410'],[.35,.20,.12,.12,.06,.15]),
}
def hx(h): h=h.lstrip('#'); return tuple(int(h[i:i+2],16) for i in (0,2,4))
def fld(r,H,W,s):
    n=r.random((max(2,H//s),max(2,W//s)))
    a=np.asarray(Image.fromarray((n*255).astype('uint8')).resize((W,H),Image.BICUBIC)).astype('float32')
    return (a-a.min())/(a.max()-a.min()+1e-6)
def box(a,k,ax):
    p=k//2; pw=[(0,0)]*3; pw[ax]=(p+1,p)
    c=np.cumsum(np.pad(a,pw,'edge'),axis=ax,dtype='float64')
    sl=lambda s: tuple(s if i==ax else slice(None) for i in range(3))
    return ((c[sl(slice(k,None))]-c[sl(slice(None,-k))])/k).astype('float32')
def ss(x,a,b): t=np.clip((x-a)/(b-a),0,1); return t*t*(3-2*t)
def paint(path,W,H,palette,seed,frame=False,shapes=8,ang=22):
    cols,w=PALETTES[palette]; r=np.random.default_rng(seed); P=[hx(c) for c in cols]
    im=Image.new('RGB',(W,H),P[0]); d=ImageDraw.Draw(im)
    for _ in range(shapes):
        c=P[r.choice(len(P),p=w)]; cx,cy=r.random()*W,r.random()*H
        rw,rh=W*(.25+r.random()*.7),H*(.12+r.random()*.6); a=np.radians(r.uniform(-ang,ang))
        d.polygon([(cx+x*np.cos(a)-y*np.sin(a),cy+x*np.sin(a)+y*np.cos(a)) for x,y in [(-rw/2,-rh/2),(rw/2,-rh/2),(rw/2,rh/2),(-rw/2,rh/2)]],fill=c)
    if frame:
        m=int(W*.09); L=P[4]; lw=max(3,W//400)
        d.rectangle([m,m,W-m,H-m],outline=L,width=lw); d.rectangle([m*2,m*2,W-m*2,H-m*2],outline=L,width=lw)
        for q in [(m,m,m*2,m*2),(W-m,m,W-m*2,m*2),(m,H-m,m*2,H-m*2),(W-m,H-m,W-m*2,H-m*2)]: d.line(q,fill=L,width=lw)
    a=np.asarray(im).astype('float32')/255; yy,xx=np.mgrid[0:H,0:W]
    dx=((fld(r,H,W,140)-.5)*W*.05).astype(int); dy=((fld(r,H,W,200)-.5)*H*.03).astype(int)
    a=a[np.clip(yy+dy,0,H-1),np.clip(xx+dx,0,W-1)]
    mh=ss(fld(r,H,W,260),.45,.62)[...,None]; mv=ss(fld(r,H,W,300),.5,.68)[...,None]
    a=a*(1-mh)+box(a,241,1)*mh; a=a*(1-mv)+box(a,161,0)*mv
    st=np.asarray(Image.fromarray((r.random((H,max(6,W//110)))*255).astype('uint8')).resize((W,H),Image.BICUBIC)).astype('float32')/255
    a*=1+.16*(st-.5)[...,None]*2; a+=r.normal(0,.03,(H,W,1)).astype('float32')
    Image.fromarray((np.clip(a,0,1)*255).astype('uint8')).save(path,quality=80,optimize=True)
if __name__=='__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('--post-id',default='default'); ap.add_argument('--size',default='1200x1500')
    ap.add_argument('--palette',choices=list(PALETTES)); ap.add_argument('-o','--out',default='cover.jpg'); a=ap.parse_args()
    h=int(hashlib.sha256(a.post_id.encode()).hexdigest(),16); W,H=map(int,a.size.split('x'))
    pal=a.palette or list(PALETTES)[h%4]; paint(a.out,W,H,pal,h%(2**32),frame=bool((h>>8)&1))
    print(a.out,pal)
