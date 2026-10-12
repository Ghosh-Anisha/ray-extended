import json,re,importlib.util,sys
spec=importlib.util.spec_from_file_location('r','run.py')
src=open('run.py').read().split("a=score('rule'")[0]
ns={}; exec(src,ns)
# rule v2: tuned on set-1 misses
def rule2(m):
    e=ns['rule_extract'](m); t=m['text'].lower()
    pay=re.search(r'(paid|pay|deduct|debit|kat|paise|money|amount|₹|rs|upi|gpay|phonepe|paytm|utr|pay_|पैसे|भुगतान|कट)',t)
    prob=re.search(r'(order|nothing|no update|no reply|not (got|received|placed|confirm)|nahi|nhi|pending|fail|could not|couldn.t|cancel\w* (sms|mail|email|message)|success page|white screen|blank|checkout|confirmation|ऑर्डर|नहीं|still)',t)
    neg=re.search(r'(refund (karo|kar do|chahiye|for my order)|return|deliver(ed|y)|where is my (order|cake)\b(?!.*paid)|kab aayega|discount|coupon|eggless|ingredient|cancel my order|cancel the order|custom cake)',t)
    e['intent']='paid_no_order' if (pay and prob and not neg) else 'other'
    # amount fallback: any 3-5 digit number not a UTR
    if e['amount'] is None:
        mm=re.search(r'\b(\d{3,5})\b',re.sub(r'\b\d{12}\b|pay_\w+','',t))
        if mm: e['amount']=int(mm.group(1))
    return e
M1=ns['M']; K1=ns['K']
def run(M,K,R,label):
    ns['M']=M; ns['K']=K
    out={}
    for name,ex in [('rule v1',ns['rule_extract']),('rule v2 (tuned on set 1)',rule2),('RAY',lambda m:R[m['id']])]:
        s=ns['score'](name,ex); out[name]=s
        print(f"{label} | {name}: outcome {s['correct']}/{len(M)}, intent {s['intent_correct']}/{len(M)}, wrong payment acted on {s['wrong_action']}")
    return out
R1={r['id']:r for r in json.load(open('extract_ray.json'))}
o1=run(M1,K1,R1,'set 1')
M2=json.load(open('messages2.json')); K2={k['id']:k for k in json.load(open('key2.json'))}; R2={r['id']:r for r in json.load(open('extract_ray2.json'))}
o2=run(M2,K2,R2,'held-out set 2')
print('\nset 2 misses:')
names=list(o2)
for idx,m in enumerate(M2):
    rr=[o2[n]['rows'][idx] for n in names]
    if not all(r[3] for r in rr):
        print(m['id'],'exp',rr[0][1],'|',' | '.join(f"{n.split()[0]+(' v2' if 'v2' in n else '')}:{r[2]}" for n,r in zip(names,rr)),'|',m['text'][:120].replace('\n',' '))
json.dump({'set1':o1,'set2':o2},open('results_all.json','w'),indent=1,default=str)
