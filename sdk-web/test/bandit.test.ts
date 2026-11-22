import {describe,expect,it} from "vitest";
import {RouteBandit} from "../src/bandit.js";
describe("RouteBandit",()=>{
 it("starts with a uniform prior",()=>expect(new RouteBandit(2).snapshot()).toEqual([{alpha:1,beta:1},{alpha:1,beta:1}]));
 it("updates evidence with exponential forgetting",()=>{const b=new RouteBandit(1,Math.random,0.5);b.observe(0,true);expect(b.snapshot()[0]).toEqual({alpha:2,beta:1});b.observe(0,false);expect(b.snapshot()[0]).toEqual({alpha:1.5,beta:2});});
 it("rejects invalid route indexes and empty candidate sets",()=>{const b=new RouteBandit(1);expect(()=>b.observe(2,true)).toThrow(RangeError);expect(()=>b.choose([])).toThrow(RangeError);});
});
