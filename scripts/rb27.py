# Extract / re-embed the 2027 Board (the RB27_HTML string literal in index.html).
# Run from the repo root:  python3 scripts/rb27.py out /tmp/rb27.html  ->  edit  ->  python3 scripts/rb27.py in /tmp/rb27.html
# "check" confirms a decode/encode round trip keeps the same meaning.
import sys
MARK='const RB27_HTML='
ESC={'n':'\n','t':'\t','"':'"',"'":"'",'\\':'\\','/':'/'}
def span(s):
    a=s.find(MARK)+len(MARK); assert s[a]=='"'
    i=a+1
    while True:
        c=s[i]
        if c=='\\': i+=2; continue
        if c=='"': return a,i+1
        i+=1
def decode(lit):
    out=[];i=1
    while i<len(lit)-1:
        c=lit[i]
        if c=='\\':
            n=lit[i+1]
            if n=='u': out.append(chr(int(lit[i+2:i+6],16))); i+=6; continue
            if n not in ESC: raise ValueError('unknown escape \\'+n)
            out.append(ESC[n]); i+=2; continue
        out.append(c); i+=1
    return ''.join(out)
def encode(h):
    e=h.replace('\\','\\\\').replace('"','\\"').replace('\n','\\n').replace('\t','\\t').replace('</','<\\/')
    return '"'+''.join(c if ord(c)<128 else '\\u%04x'%ord(c) for c in e)+'"'
if __name__=='__main__':
    cmd,html_path=sys.argv[1],sys.argv[2]
    s=open('index.html',encoding='utf-8').read(); a,b=span(s)
    if cmd=='out': open(html_path,'w',encoding='utf-8').write(decode(s[a:b])); print('extracted',b-a)
    elif cmd=='check': lit=s[a:b]; print('roundtrip same meaning:', decode(encode(decode(lit)))==decode(lit))
    elif cmd=='in':
        h=open(html_path,encoding='utf-8').read(); s=s[:a]+encode(h)+s[b:]; open('index.html','w',encoding='utf-8').write(s); print('embedded',len(h))
