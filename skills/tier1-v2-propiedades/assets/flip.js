(function(){
var $=function(i){return document.getElementById(i)},f=function(v){return (v<0?"-$":"$")+Math.abs(Math.round(v)).toLocaleString("en-US")},num=function(i){return parseFloat($(i).value)||0};
var CL=0.02,CF=200,CP=0.0023;
function calc(){
 var b=num("buy"),r=num("reno"),a=num("arv"),m=num("months"),sp=num("sellpct")/100,t=num("target"),ln=num("loan");
 var intr=ln?ln*num("rate")/100*m/12+ln*0.02:0;
 var close=b*CL,hold=m*(CF+b*CP),cost=b+close+r+hold+intr,sell=a*sp,pr=a-sell-cost;
 var mao=(a*(1-sp)-t-r-m*CF-intr)/(1+CL+m*CP),bep=(a*(1-sp)-r-m*CF-intr)/(1+CL+m*CP);
 $("p_buy").textContent=f(b);$("p_close").textContent=f(close);$("p_reno").textContent=f(r);$("p_hold").textContent=f(hold);$("p_int").textContent=f(intr);$("p_cost").textContent=f(cost);
 $("p_arv").textContent=f(a);$("p_sell").textContent=f(sell);$("p_profit").textContent=f(pr);$("p_roi").textContent=(pr/cost*100).toFixed(1)+"%";$("p_mao").textContent=f(mao);$("p_bep").textContent=f(bep);
 var c=pr<0?"bad":pr<t?"warn":"good";$("p_profit").className="n "+c;$("t_profit").textContent=f(pr);$("t_profit").className="v "+c;$("t_roi").textContent=(pr/cost*100).toFixed(1)+"% on cash"+(intr?", after loan cost":", before any financing cost");
}
document.addEventListener("input",calc);calc();
})();
