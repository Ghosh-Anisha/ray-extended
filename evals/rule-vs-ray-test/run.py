import json,re,datetime as dt
L=json.load(open('ledger.json')); M=json.load(open('messages.json')); K={k['id']:k for k in json.load(open('key.json'))}
R={r['id']:r for r in json.load(open('extract_ray.json'))}
P=lambda s:dt.datetime.fromisoformat(s)
WD={'monday':0,'tuesday':1,'wednesday':2,'thursday':3,'friday':4,'saturday':5,'sunday':6,'somvar':0,'mangalvar':1,'budhvar':2,'guruvar':3,'shukravar':4,'shanivar':5,'ravivar':6}
def rule_extract(m):
    t=m['text'].lower(); rec=P(m['received_at'])
    pay=re.search(r'\b(paid|payment|pay|deduct\w*|debit\w*|kat|kata|kat gaye|paise|paisa|money|amount|transfer|₹|rs\.?|upi|gpay|phonepe|paytm|पैसे|भुगतान|कट)',t)
    prob=re.search(r'(order\s*(nahi|nhi|not|no)|no order|not (got|received|placed|confirmed)|nahi aaya|nhi aaya|nahi mila|pending|failed|fail|cancel\w* (sms|mail|email|message)|confirm\w* nahi|nahi hua|not confirm|success page|white screen|blank|back to (the )?checkout|no confirmation|ऑर्डर|नहीं)',t)
    neg=re.search(r'(refund (karo|kar do|chahiye|please|for my order)|return|deliver|delivery|where is my|kab aayega|discount|coupon|code|eggless|ingredient|cancel my order|cancel the order)',t)
    intent='paid_no_order' if (pay and prob and not neg) else 'other'
    am=None
    mm=re.search(r'(?:₹|rs\.?|inr)\s*([\d,]{3,6})|\b([\d,]{3,6})\s*(?:/-|rs|rupees|ka|ke|diye|paid)',t) or re.search(r'\b(\d{3,4})\b(?!\d)',re.sub(r'\b\d{12}\b','',t))
    if mm:
        g=[x for x in mm.groups() if x] if mm.groups() else [mm.group(0)]
        try: am=int(g[0].replace(',',''))
        except: am=None
    d=None
    if re.search(r'\b(aaj|today|abhi|just now|aj)\b',t): d=0
    elif re.search(r'(day before yesterday|parso|2 din|two days)',t): d=2
    elif re.search(r'\b(kal|yesterday|last night)\b',t): d=1
    else:
        for w,i in WD.items():
            if w in t: d=(rec.weekday()-i)%7 or 7; break
    df=dt_=None
    if d is not None:
        day=(rec-dt.timedelta(days=d)).replace(hour=0,minute=0); df,dt_=day,day+dt.timedelta(hours=23,minutes=59)
    utr=re.search(r'\b\d{12}\b',t); pid=re.search(r'pay_\w+',m['text'])
    return dict(intent=intent,amount=am,date_from=df.isoformat() if df else None,date_to=dt_.isoformat() if dt_ else None,utr=utr.group(0) if utr else None,pay_id=pid.group(0) if pid else None)
def match(m,e):
    if e['intent']!='paid_no_order': return 'none'
    rec=P(m['received_at'])
    if e.get('pay_id'):
        c=[p for p in L if p['payment_id']==e['pay_id']]
        if c: return 'match:'+c[0]['payment_id'] if c[0]['status']=='captured_no_order' else 'ask'
    if e.get('utr'):
        c=[p for p in L if p['utr']==e['utr']]
        if c: return 'match:'+c[0]['payment_id'] if c[0]['status']=='captured_no_order' else 'ask'
    c=[p for p in L if (m.get('sender_phone') and p['phone']==m['sender_phone']) or (m.get('sender_email') and p['email']==m['sender_email'])]
    if e.get('amount'): c=[p for p in c if p['amount']==e['amount']]
    lo=P(e['date_from'])-dt.timedelta(hours=2) if e.get('date_from') else rec-dt.timedelta(hours=72)
    hi=P(e['date_to'])+dt.timedelta(hours=2) if e.get('date_to') else rec
    c=[p for p in c if lo<=P(p['created_at'])<=hi]
    if len(c)==1 and c[0]['status']=='captured_no_order': return 'match:'+c[0]['payment_id']
    return 'ask'
def score(name,ex):
    rows=[];ok=0;wrong=0;ints=0
    for m in M:
        e=ex(m); got=match(m,e); exp=K[m['id']]['expected']
        ki=K[m['id']]['intent']; ii=(e['intent']=='paid_no_order')==(ki=='paid_no_order'); ints+=ii
        if got==exp: ok+=1
        if got.startswith('match') and got!=exp: wrong+=1
        rows.append((m['id'],exp,got,got==exp))
    return dict(name=name,correct=ok,intent_correct=ints,wrong_action=wrong,rows=rows)
a=score('rule',rule_extract); b=score('ray',lambda m:R[m['id']])
for s in (a,b): print(s['name'],'outcome correct',s['correct'],'/40 | intent correct',s['intent_correct'],'/40 | acted on wrong payment',s['wrong_action'])
from collections import Counter
for s in (a,b):
    c=Counter()
    for i,exp,got,okk in s['rows']:
        kind=exp.split(':')[0]; c[(kind,okk)]+=1
    print(s['name'],dict(c))
print('\nmisses:')
for (i,exp,g1,o1),(_,_,g2,o2) in zip(a['rows'],b['rows']):
    if not(o1 and o2):
        t=[m for m in M if m['id']==i][0]['text']
        print(i,'exp',exp,'| rule',g1,'| ray',g2,'|',t[:110].replace('\n',' '))
json.dump({'rule':a,'ray':b},open('results.json','w'),indent=1,default=str)
