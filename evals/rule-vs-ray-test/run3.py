import json,re
C=json.load(open('cause_cases.json')); CK={k['id']:k for k in json.load(open('cause_key.json'))}; CR={r['id']:r for r in json.load(open('cause_ray.json'))}
FAULT={'sql_error_in_handler':'razorpay_plugin','fatal_error_in_handler':'razorpay_plugin','cron_not_retrying':'razorpay_plugin','authorize_mode_not_captured':'razorpay_plugin','retry_on_new_order_not_linked':'razorpay_plugin',
 'endpoint_timeout':'merchant_site_or_hosting','theme_plugin_conflict':'merchant_site_or_hosting','wp_cron_not_running':'merchant_site_or_hosting','firewall_blocked':'merchant_config',
 'hold_stock_autocancel':'merchant_config','webhook_disabled':'merchant_site_or_hosting','no_webhook_and_tab_closed':'merchant_config','signature_mismatch':'merchant_config','razorpay_platform_delay':'razorpay_platform','no_issue_found':'none'}
def status_rule(e):
    d=[x for x in (e.get('webhook_deliveries') or []) if isinstance(x,dict)]
    if not d: return 'no_webhook_and_tab_closed'
    sts=[x.get('http_status') for x in d]; ms=[x.get('response_ms') or 0 for x in d]
    if any(s in (None,0,408,504) or m>=5000 for s,m in zip(sts,ms)): return 'endpoint_timeout'
    if any(s==403 for s in sts): return 'firewall_blocked'
    if any(s and s>=500 for s in sts): return 'fatal_error_in_handler'
    return 'no_issue_found'   # "webhook got a 200, no issue on our side"
def keyword_rule(e):
    blob=json.dumps(e).lower()
    checks=[('unknown column|sql|database error','sql_error_in_handler'),('signature','signature_mismatch'),('disabled','webhook_disabled'),
            ('fatal error','fatal_error_in_handler'),('403|forbidden|wordfence|firewall','firewall_blocked'),
            ('unpaid order cancelled|time limit reached','hold_stock_autocancel'),('"payment_action": "authorize"','authorize_mode_not_captured'),
            ('disable_wp_cron|cron not|wp-cron disabled','wp_cron_not_running'),('cron','cron_not_retrying')]
    for pat,lab in checks:
        if re.search(pat,blob): return lab
    s=status_rule(e)
    return s
def sc(name,f):
    c=f_=0;rows=[]
    for x in C:
        k=CK[x['id']]; g=f(x)
        cause=g if isinstance(g,str) else g['cause']; fault=FAULT.get(cause,'none') if isinstance(g,str) else g['fault']
        c+=cause==k['cause']; f_+=fault==k['fault']; rows.append((x['id'],k['cause'],cause))
    print(f"{name}: cause {c}/16, whose fault {f_}/16"); return rows
a=sc('status-code rule (today: "webhook got 200")',lambda x:status_rule(x['evidence']))
b=sc('keyword rule engine (reads bodies, logs, notes)',lambda x:keyword_rule(x['evidence']))
r=sc('RAY',lambda x:CR[x['id']])
print('misses:')
for (i,k,g1),(_,_,g2),(_,_,g3) in zip(a,b,r):
    if not (g2==k and g3==k): print(i,'key',k,'| status',g1,'| keyword',g2,'| RAY',g3)
print('status rule says "no issue found" in', sum(1 for _,_,g in a if g=='no_issue_found'),'of 16')

D=json.load(open('decide_cases.json')); DK={k['id']:k for k in json.load(open('decide_key.json'))}; DR={r['id']:r for r in json.load(open('decide_ray.json'))}
def drule(c):
    x=c['context']
    if x.get('open_dispute'): return 'escalate_to_merchant'
    if x.get('newer_payment_same_contact'): return 'mark_paid_and_refund_duplicate'
    if not x.get('stock_available'): return 'refund'
    return 'mark_paid'
def drule2(c):
    x=c['context']; t=' '.join(m['text'].lower() for m in x['conversation'] if m['from']=='customer')
    last=[m['text'].lower() for m in x['conversation'] if m['from']=='customer'][-1]
    if re.search(r'consumer court|legal|police|fraud|cheat',t): return 'escalate_to_merchant'
    if re.search(r'refund|paisa wapas|paise wapas|money back|cancel',last): return 'refund'
    return drule(c)
for name,f in [('stock + pre-check rule',drule),('rule + keywords (refund/cancel/legal)',drule2),('RAY',lambda c:DR[c['id']]['action'])]:
    ok=sum(f(c)==DK[c['id']]['action'] for c in D); print(f"{name}: {ok}/16")
print('decide misses:')
for c in D:
    k=DK[c['id']]['action']; g=[drule(c),drule2(c),DR[c['id']]['action']]
    if not all(x==k for x in g): print(c['id'],'key',k,'| rule',g[0],'| rule+kw',g[1],'| RAY',g[2],'|',DK[c['id']]['why'][:80])
