import json
g={}; src=open('run3.py').read(); exec(src[:src.find("a=sc(")],g); exec(src[src.find('def drule(c)'):src.find('for name,f in')],g)
HC=json.load(open('hard_cause_cases.json')); HK={k['id']:k for k in json.load(open('hard_cause_key.json'))}; HR={r['id']:r for r in json.load(open('hard_cause_ray.json'))}
print('HARD cause:')
for x in HC:
    e=x['evidence']; k=HK[x['id']]
    print(x['id'],'key',k['cause'],'/',k['fault'],'| status',g['status_rule'](e),'| keyword',g['keyword_rule'](e),'| RAY',HR[x['id']]['cause'],'/',HR[x['id']]['fault'])
HD=json.load(open('hard_decide_cases.json')); HDK={k['id']:k for k in json.load(open('hard_decide_key.json'))}; HDR={r['id']:r for r in json.load(open('hard_decide_ray.json'))}
print('HARD decide:')
for c in HD:
    try: r1=g['drule'](c); r2=g['drule2'](c)
    except Exception as ex: r1=r2='err'
    print(c['id'],'key',HDK[c['id']]['action'],'| rule',r1,'| rule+kw',r2,'| RAY',HDR[c['id']]['action'],'|',HDK[c['id']]['why'][:90])
